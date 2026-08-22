import ngrok from '@ngrok/ngrok';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

async function startTunnel() {
  console.log('\n🚀 Starting QuickDrop ngrok tunnel for port 5173...\n');

  // Attempt to read authtoken from ngrok config if not set in env
  let authtoken = process.env.NGROK_AUTHTOKEN;
  if (!authtoken) {
    const configPath = path.join(os.homedir(), 'AppData', 'Local', 'ngrok', 'ngrok.yml');
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8');
      const match = content.match(/authtoken:\s*([^\s\r\n]+)/);
      if (match && match[1]) {
        authtoken = match[1];
      }
    }
  }

  try {
    const listener = await ngrok.forward({
      addr: 5173,
      authtoken: authtoken,
    });

    const publicUrl = listener.url();

    console.log('='.repeat(60));
    console.log('✅ NGROK TUNNEL IS ACTIVE & RUNNING');
    console.log('='.repeat(60));
    console.log(`\n📱 Public Forwarding URL: ${publicUrl}`);
    console.log(`\n👉 OPEN THIS ON YOUR LAPTOP BROWSER:`);
    console.log(`   ${publicUrl}/shop\n`);
    console.log(`👉 THEN SCAN THE ON-SCREEN QR CODE WITH YOUR PHONE!\n`);
    console.log('='.repeat(60));
    console.log('(Tunnel will stay open. Press Ctrl+C in this terminal to stop.)\n');

    // Keep event loop active
    setInterval(() => {}, 60000);
  } catch (err) {
    console.error('\n❌ Failed to start ngrok tunnel:', err.message);
    if (err.message.includes('authtoken') || err.message.includes('authentication')) {
      console.log('\nPlease verify your auth token in C:\\Users\\VARUN\\AppData\\Local\\ngrok\\ngrok.yml\n');
    }
    process.exit(1);
  }
}

startTunnel();
