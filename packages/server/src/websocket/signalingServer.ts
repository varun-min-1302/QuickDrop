import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import {
  ClientSignalingMessageSchema,
  ServerSignalingMessage,
  IceServerConfig,
  PROTOCOL_VERSION,
} from '@quickdrop/shared';
import { ISessionStore } from '../redis/sessionStore.js';
import { config, getIceServers } from '../config.js';

import { generateCustomerCode } from '../utils/crypto.js';

interface ConnectedPeer {
  connectionId: string;
  peerId: string;
  socket: WebSocket;
  sessionId?: string;
  role?: 'shop' | 'customer';
  clientId?: string;
  isAlive: boolean;
  messageCount: number;
  lastWindowReset: number;
}

export interface CustomerConnection {
  peerId: string;
  clientId: string;
  customerCode: string;
  batchId: string;
  displayName: string | null;
  status: 'CONNECTING' | 'CONNECTED';
}

export class SignalingManager {
  private peers = new Map<string, ConnectedPeer>(); // connectionId -> ConnectedPeer
  private sessionPeers = new Map<string, { 
    shopPeerId?: string; 
    customers: Map<string, CustomerConnection>; // Keyed by customer peerId
  }>();
  private sessionStore: ISessionStore;
  private heartbeatInterval?: NodeJS.Timeout;

  constructor(sessionStore: ISessionStore) {
    this.sessionStore = sessionStore;
    this.startHeartbeat();
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      for (const [connectionId, peer] of this.peers.entries()) {
        if (!peer.isAlive) {
          peer.socket.terminate();
          this.handleDisconnect(connectionId);
          continue;
        }
        // Mark false until next message, pong, or ping
        peer.isAlive = false;
        if (peer.socket.readyState === WebSocket.OPEN) {
          peer.socket.ping();
        }
      }
    }, 30000);

    if (this.heartbeatInterval.unref) {
      this.heartbeatInterval.unref();
    }
  }

  public handleConnection(socket: WebSocket) {
    const connectionId = crypto.randomUUID();
    const peerId = crypto.randomUUID();

    const peer: ConnectedPeer = {
      connectionId,
      peerId,
      socket,
      isAlive: true,
      messageCount: 0,
      lastWindowReset: Date.now(),
    };

    this.peers.set(connectionId, peer);

    socket.on('pong', () => {
      peer.isAlive = true;
    });

    socket.on('message', async (data: Buffer | string) => {
      // Refresh liveness on ANY incoming message frame
      peer.isAlive = true;

      try {
        // 1. Rate Limiting Check (per peer)
        const now = Date.now();
        if (now - peer.lastWindowReset > 10000) {
          peer.messageCount = 0;
          peer.lastWindowReset = now;
        }
        peer.messageCount++;

        if (peer.messageCount > config.MAX_WEBSOCKET_MESSAGES_PER_WINDOW) {
          this.sendMessage(socket, {
            type: 'ERROR',
            code: 'RATE_LIMITED',
            message: 'Signaling message rate limit exceeded. Connection terminated.',
          });
          socket.terminate();
          this.handleDisconnect(connectionId);
          return;
        }

        // 2. Payload size check
        const rawString = typeof data === 'string' ? data : data.toString('utf-8');
        if (rawString.length > config.MAX_WEBSOCKET_MESSAGE_BYTES) {
          this.sendMessage(socket, {
            type: 'ERROR',
            code: 'PAYLOAD_TOO_LARGE',
            message: 'Signaling message exceeds maximum permitted size.',
          });
          return;
        }

        // 3. Schema validation
        let parsedJson: any;
        try {
          parsedJson = JSON.parse(rawString);
        } catch {
          this.sendMessage(socket, {
            type: 'ERROR',
            code: 'INVALID_JSON',
            message: 'Message must be valid JSON.',
          });
          return;
        }

        const parseResult = ClientSignalingMessageSchema.safeParse(parsedJson);
        if (!parseResult.success) {
          this.sendMessage(socket, {
            type: 'ERROR',
            code: 'INVALID_MESSAGE',
            message: 'Signaling message format is invalid or unknown message type.',
          });
          return;
        }

        const msg = parseResult.data;

        switch (msg.type) {
          case 'PING':
            peer.isAlive = true;
            this.sendMessage(socket, { type: 'PONG' });
            break;

          case 'JOIN':
            await this.handleJoin(peer, msg);
            break;

          case 'CUSTOMER_UPDATED':
            if (!peer.sessionId || peer.role !== 'customer') {
              this.sendMessage(socket, { type: 'ERROR', code: 'UNAUTHORIZED', message: 'Must join as customer first.' });
              return;
            }
            this.handleCustomerUpdated(peer, msg);
            break;

          case 'BATCH_COMPLETED':
            if (!peer.sessionId || peer.role !== 'customer') {
              this.sendMessage(socket, { type: 'ERROR', code: 'UNAUTHORIZED', message: 'Must join as customer first.' });
              return;
            }
            this.handleBatchCompleted(peer, msg);
            break;

          case 'OFFER':
          case 'ANSWER':
          case 'ICE_CANDIDATE':
            if (!peer.sessionId) {
              this.sendMessage(socket, { type: 'ERROR', code: 'UNAUTHORIZED', message: 'Must join session first.' });
              return;
            }
            this.handleRelay(peer, msg as any);
            break;

          case 'LEAVE':
            this.handleDisconnect(connectionId);
            break;
        }
      } catch (err: any) {
        this.sendMessage(socket, {
          type: 'ERROR',
          code: 'PROCESSING_ERROR',
          message: err?.message || 'Failed to process signaling message',
        });
      }
    });

    socket.on('close', () => {
      this.handleDisconnect(connectionId);
    });

    socket.on('error', () => {
      this.handleDisconnect(connectionId);
    });
  }

  private async handleJoin(
    peer: ConnectedPeer,
    msg: {
      type: 'JOIN';
      role: 'shop' | 'customer';
      token?: string;
      sessionId?: string;
      numericCode?: string;
      clientId?: string;
    }
  ) {
    let session = null;

    if (msg.role === 'shop') {
      // Phase I — shop-role ownership tightening. The raw joinToken is the shop's proof
      // of ownership: the server stores only its hash, so only the peer that created the
      // session (the authenticated shop that called the create endpoint) can present it.
      // A bridge customer (§16) receives only sessionId + numericCode, never the raw
      // token, so it can no longer claim the shop role by replaying the sessionId it was
      // handed. Requiring the token here is additive — every existing shop JOIN already
      // sends it alongside the sessionId.
      if (!msg.token) {
        this.sendMessage(peer.socket, {
          type: 'JOIN_REJECTED',
          code: 'INVALID_TOKEN',
          reason: 'Joining as the shop requires the session join token.',
        });
        return;
      }
      session = await this.sessionStore.getSessionByToken(msg.token);
      // When a sessionId is also supplied it must reference the same session the token
      // resolves to; a mismatch signals stitched-together credentials and is refused.
      if (session && msg.sessionId && msg.sessionId !== session.sessionId) {
        this.sendMessage(peer.socket, {
          type: 'JOIN_REJECTED',
          code: 'INVALID_TOKEN',
          reason: 'The provided session identifier does not match the join token.',
        });
        return;
      }
    } else {
      // Customer: lookup by join token or numeric backup code. A bridge customer (§16)
      // arrives with only the numericCode, so the token lookup is guarded.
      if (msg.token) {
        session = await this.sessionStore.getSessionByToken(msg.token);
      }
      if (!session && msg.numericCode) {
        session = await this.sessionStore.getSessionByNumericCode(msg.numericCode);
      }
    }

    if (!session) {
      this.sendMessage(peer.socket, {
        type: 'JOIN_REJECTED',
        code: 'SESSION_NOT_FOUND',
        reason: 'The requested transfer session does not exist or has expired.',
      });
      return;
    }

    if (Date.now() > session.expiresAt || session.status === 'EXPIRED' || session.status === 'CLOSED') {
      this.sendMessage(peer.socket, {
        type: 'JOIN_REJECTED',
        code: 'SESSION_EXPIRED',
        reason: 'This transfer session has expired.',
      });
      return;
    }

    const sessionId = session.sessionId;
    peer.sessionId = sessionId;
    peer.role = msg.role;
    peer.clientId = msg.clientId;

    if (!this.sessionPeers.has(sessionId)) {
      this.sessionPeers.set(sessionId, { customers: new Map() });
    }
    const sessionGroup = this.sessionPeers.get(sessionId)!;

    const iceServers = getIceServers() as IceServerConfig[];

    if (msg.role === 'shop') {
      sessionGroup.shopPeerId = peer.peerId;
      await this.sessionStore.setShopConnection(sessionId, peer.connectionId);

      this.sendMessage(peer.socket, {
        type: 'JOIN_ACCEPTED',
        sessionId,
        role: 'shop',
        peerId: peer.peerId,
        iceServers,
        expiresAt: session.expiresAt,
        protocolVersion: PROTOCOL_VERSION,
      });

      // If customers are already connected, notify shop of all of them
      for (const customer of sessionGroup.customers.values()) {
        this.sendMessage(peer.socket, {
          type: 'PEER_JOINED',
          peerId: customer.peerId,
          role: 'customer',
          customer: {
            clientId: customer.clientId,
            customerCode: customer.customerCode,
            displayName: customer.displayName,
            batchId: customer.batchId,
          },
        });
      }

      // BUG FIX: Notify all waiting customers that the shop is now present.
      // Without this, customers who connected BEFORE the shop opens the dashboard
      // will never receive PEER_JOINED(shop) and will wait in CONNECTING forever.
      for (const customer of sessionGroup.customers.values()) {
        const customerPeer = this.getPeerById(customer.peerId);
        if (customerPeer && customerPeer.socket.readyState === WebSocket.OPEN) {
          this.sendMessage(customerPeer.socket, {
            type: 'PEER_JOINED',
            peerId: peer.peerId,
            role: 'shop',
          });
        }
      }
    } else {
      // Customer handling
      // Check for reconnect using clientId
      let existingCustomerPeerId: string | undefined;
      for (const [custPeerId, custConn] of sessionGroup.customers.entries()) {
        if (custConn.clientId === msg.clientId && msg.clientId) {
          existingCustomerPeerId = custPeerId;
          break;
        }
      }

      let customerCode = '';
      let batchId = '';
      let displayName: string | null = null;

      if (existingCustomerPeerId) {
        // Reconnect: terminate old socket and reuse metadata
        const existingPeer = this.getPeerById(existingCustomerPeerId);
        if (existingPeer) {
          existingPeer.socket.terminate();
          this.peers.delete(existingPeer.connectionId);
        }
        
        const oldConn = sessionGroup.customers.get(existingCustomerPeerId)!;
        customerCode = oldConn.customerCode;
        batchId = oldConn.batchId;
        displayName = oldConn.displayName;
        
        sessionGroup.customers.delete(existingCustomerPeerId);

        // Notify shop that the old peer left, so it can clean up before the new one joins
        if (sessionGroup.shopPeerId) {
          const shopPeer = this.getPeerById(sessionGroup.shopPeerId);
          if (shopPeer && shopPeer.socket.readyState === WebSocket.OPEN) {
            this.sendMessage(shopPeer.socket, {
              type: 'PEER_LEFT',
              peerId: existingCustomerPeerId,
              role: 'customer',
              clientId: oldConn.clientId,
            });
          }
        }
      } else {
        // Enforce max capacity (e.g., 50 customers limit)
        // Since we import LIMITS, we can use 50 hardcoded or add it to LIMITS.
        // I will use 50 directly for now.
        if (sessionGroup.customers.size >= 50) {
          this.sendMessage(peer.socket, {
            type: 'JOIN_REJECTED',
            code: 'SESSION_OCCUPIED',
            reason: 'Maximum number of customers reached for this session.',
          });
          return;
        }

        // New connection
        // Generate unique customer code
        do {
          customerCode = generateCustomerCode();
        } while (Array.from(sessionGroup.customers.values()).some(c => c.customerCode === customerCode));
        batchId = `batch_${crypto.randomUUID()}`;

        await this.sessionStore.updateCustomerCount(sessionId, 1);
      }

      const customerConn: CustomerConnection = {
        peerId: peer.peerId,
        clientId: peer.clientId || crypto.randomUUID(),
        customerCode,
        batchId,
        displayName,
        status: 'CONNECTING',
      };

      sessionGroup.customers.set(peer.peerId, customerConn);

      this.sendMessage(peer.socket, {
        type: 'JOIN_ACCEPTED',
        sessionId,
        role: 'customer',
        peerId: peer.peerId,
        iceServers,
        expiresAt: session.expiresAt,
        protocolVersion: PROTOCOL_VERSION,
        customerCode,
        batchId,
      });

      // Notify shop that this customer joined
      if (sessionGroup.shopPeerId) {
        const shopPeer = this.getPeerById(sessionGroup.shopPeerId);
        if (shopPeer && shopPeer.socket.readyState === WebSocket.OPEN) {
          this.sendMessage(shopPeer.socket, {
            type: 'PEER_JOINED',
            peerId: peer.peerId,
            role: 'customer',
            customer: {
              clientId: customerConn.clientId,
              customerCode,
              displayName,
              batchId,
            },
          });

          // Also notify customer of shop peer presence
          this.sendMessage(peer.socket, {
            type: 'PEER_JOINED',
            peerId: shopPeer.peerId,
            role: 'shop',
          });
        }
      }
    }
  }

  private handleCustomerUpdated(peer: ConnectedPeer, msg: { type: 'CUSTOMER_UPDATED', displayName: string | null }) {
    const sessionGroup = this.sessionPeers.get(peer.sessionId!);
    if (!sessionGroup) return;

    const customer = sessionGroup.customers.get(peer.peerId);
    if (!customer) return;

    customer.displayName = msg.displayName;

    // Relay to shop
    if (sessionGroup.shopPeerId) {
      const shopPeer = this.getPeerById(sessionGroup.shopPeerId);
      if (shopPeer && shopPeer.socket.readyState === WebSocket.OPEN) {
        this.sendMessage(shopPeer.socket, {
          type: 'CUSTOMER_UPDATED',
          peerId: peer.peerId,
          clientId: customer.clientId,
          displayName: msg.displayName,
        });
      }
    }
  }

  private handleBatchCompleted(peer: ConnectedPeer, msg: { type: 'BATCH_COMPLETED' }) {
    const sessionGroup = this.sessionPeers.get(peer.sessionId!);
    if (!sessionGroup) return;

    const customer = sessionGroup.customers.get(peer.peerId);
    if (!customer) return;

    // Relay to shop
    if (sessionGroup.shopPeerId) {
      const shopPeer = this.getPeerById(sessionGroup.shopPeerId);
      if (shopPeer && shopPeer.socket.readyState === WebSocket.OPEN) {
        this.sendMessage(shopPeer.socket, {
          type: 'BATCH_COMPLETED',
          peerId: peer.peerId,
          clientId: customer.clientId,
        });
      }
    }
  }

  private handleRelay(senderPeer: ConnectedPeer, msg: any) {
    if (!senderPeer.sessionId) return;
    const sessionGroup = this.sessionPeers.get(senderPeer.sessionId);
    if (!sessionGroup) return;

    // If shop sends message, it MUST specify targetPeerId for a customer.
    // If customer sends message, it ALWAYS goes to the shop, regardless of what they specified.
    let targetPeerId: string | undefined;
    if (senderPeer.role === 'customer') {
      targetPeerId = sessionGroup.shopPeerId;
    } else {
      targetPeerId = msg.targetPeerId;
    }

    if (!targetPeerId) return;

    const targetPeer = this.getPeerById(targetPeerId);
    if (targetPeer && targetPeer.socket.readyState === WebSocket.OPEN) {
      // Re-craft msg without targetPeerId, adding fromPeerId instead
      const relayedMsg = { ...msg };
      delete relayedMsg.targetPeerId;
      relayedMsg.fromPeerId = senderPeer.peerId;
      this.sendMessage(targetPeer.socket, relayedMsg);
    }
  }

  private handleDisconnect(connectionId: string) {
    const peer = this.peers.get(connectionId);
    if (!peer) return;

    this.peers.delete(connectionId);

    if (peer.sessionId) {
      const sessionGroup = this.sessionPeers.get(peer.sessionId);
      if (sessionGroup) {
        if (peer.role === 'shop' && sessionGroup.shopPeerId === peer.peerId) {
          sessionGroup.shopPeerId = undefined;
          this.sessionStore.clearShopConnection(peer.sessionId);
          // Notify ALL customers of transient signaling peer departure without terminating the session
          for (const customer of sessionGroup.customers.values()) {
            const customerPeer = this.getPeerById(customer.peerId);
            if (customerPeer && customerPeer.socket.readyState === WebSocket.OPEN) {
              this.sendMessage(customerPeer.socket, {
                type: 'PEER_LEFT',
                peerId: peer.peerId,
                role: 'shop',
              });
            }
          }
        } else if (peer.role === 'customer' && sessionGroup.customers.has(peer.peerId)) {
          const customerConn = sessionGroup.customers.get(peer.peerId);
          sessionGroup.customers.delete(peer.peerId);
          this.sessionStore.updateCustomerCount(peer.sessionId, -1);
          
          if (sessionGroup.shopPeerId) {
            const shopPeer = this.getPeerById(sessionGroup.shopPeerId);
            if (shopPeer && shopPeer.socket.readyState === WebSocket.OPEN) {
              this.sendMessage(shopPeer.socket, {
                type: 'PEER_LEFT',
                peerId: peer.peerId,
                role: 'customer',
                clientId: customerConn?.clientId,
              });
            }
          }
        }
      }
    }
  }

  public terminateSession(sessionId: string, reason = 'Transfer session ended.') {
    const sessionGroup = this.sessionPeers.get(sessionId);
    if (sessionGroup) {
      for (const customer of sessionGroup.customers.values()) {
        const customerPeer = this.getPeerById(customer.peerId);
        if (customerPeer && customerPeer.socket.readyState === WebSocket.OPEN) {
          this.sendMessage(customerPeer.socket, {
            type: 'SESSION_CLOSED',
            reason,
          });
        }
      }
      if (sessionGroup.shopPeerId) {
        const shopPeer = this.getPeerById(sessionGroup.shopPeerId);
        if (shopPeer && shopPeer.socket.readyState === WebSocket.OPEN) {
          this.sendMessage(shopPeer.socket, {
            type: 'SESSION_CLOSED',
            reason,
          });
        }
      }
      this.sessionPeers.delete(sessionId);
    }
  }

  private getPeerById(peerId: string): ConnectedPeer | undefined {
    for (const peer of this.peers.values()) {
      if (peer.peerId === peerId) return peer;
    }
    return undefined;
  }

  private sendMessage(socket: WebSocket, msg: ServerSignalingMessage) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  }

  public close() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    for (const peer of this.peers.values()) {
      peer.socket.terminate();
    }
    this.peers.clear();
    this.sessionPeers.clear();
  }
}
