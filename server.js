const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

// Load configurations
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = {
  port: 5000,
  batchTimeoutMs: 10000,
  smtp: {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    user: "smtp-user",
    pass: "smtp-password",
    from: "router-reports@example.com",
    to: "recipient@example.com"
  },
  subnets: [
    { "name": "VLAN 18", "cidr": "172.18.0.0/16" },
    { "name": "VLAN 31", "cidr": "172.31.0.0/16" },
    { "name": "VLAN 30", "cidr": "172.30.0.0/16" }
  ],
  excludeFromTop10: [
    "172.30.0.0/16"
  ]
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      console.log('[Server] Loaded configurations from config.json');
    } else {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
      console.log('[Server] Created default config.json');
    }
  } catch (err) {
    console.error('[Server] Error reading config.json:', err.message);
  }
}
loadConfig();

const app = express();

// Logger middleware (runs BEFORE body parsers)
app.use((req, res, next) => {
  console.log(`[HTTP Incoming] ${req.method} ${req.url}`);
  next();
});

// Body parsers
app.use(express.json());
app.use(express.text({ type: '*/*' })); // Catch raw text or non-json formats

const PORT = config.port || 5000;
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Helper: Check if IP is in CIDR subnet
function ipInSubnet(ip, cidr) {
  try {
    const [range, bitsStr = '32'] = cidr.split('/');
    const bits = parseInt(bitsStr, 10);
    
    const ipParts = ip.split('.').map(Number);
    const rangeParts = range.split('.').map(Number);
    
    if (ipParts.length !== 4 || rangeParts.length !== 4) return false;
    
    const ipInt = ((ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3]) >>> 0;
    const rangeInt = ((rangeParts[0] << 24) | (rangeParts[1] << 16) | (rangeParts[2] << 8) | rangeParts[3]) >>> 0;
    
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    
    return (ipInt & mask) === (rangeInt & mask);
  } catch (e) {
    return false;
  }
}

// In-memory buffer for active batches
const activeBatches = {};

// Process a completed batch
function processBatch(batchId) {
  const batch = activeBatches[batchId];
  if (!batch) return;

  console.log(`[Batch Processor] Processing batch "${batchId}" with ${batch.items.length} items...`);
  
  // Reload config to get potential updates on subnets or smtp credentials
  loadConfig();

  // 1. Extract device list from requests
  const devices = batch.items.map(reqBody => {
    if (typeof reqBody === 'string') {
      try { return JSON.parse(reqBody); } catch (e) { return null; }
    }
    return reqBody;
  }).filter(Boolean);

  // 2. Initialize Subnet aggregation
  const subnetTotals = {};
  config.subnets.forEach(sub => {
    subnetTotals[sub.name] = { cidr: sub.cidr, total_mb: 0, deviceCount: 0 };
  });
  subnetTotals['Unmatched'] = { cidr: 'N/A', total_mb: 0, deviceCount: 0 };

  const eligibleForTop10 = [];

  // 3. Perform calculations
  devices.forEach(dev => {
    const totalMb = parseFloat(dev.total_mb) || 0;
    const ipList = (dev.ips || '').split(';').map(ip => ip.trim()).filter(ip => ip && ip !== 'no-ip');

    // Subnet aggregation match
    let matchedSubnet = null;
    for (const sub of config.subnets) {
      if (ipList.some(ip => ipInSubnet(ip, sub.cidr))) {
        matchedSubnet = sub.name;
        break;
      }
    }

    if (matchedSubnet) {
      subnetTotals[matchedSubnet].total_mb += totalMb;
      subnetTotals[matchedSubnet].deviceCount++;
    } else {
      subnetTotals['Unmatched'].total_mb += totalMb;
      subnetTotals['Unmatched'].deviceCount++;
    }

    // Exclude list match for Top 10
    let isExcluded = false;
    for (const excludeCidr of config.excludeFromTop10) {
      if (ipList.some(ip => ipInSubnet(ip, excludeCidr))) {
        isExcluded = true;
        break;
      }
    }

    if (!isExcluded) {
      eligibleForTop10.push({
        name: dev.name,
        mac: dev.mac,
        ips: ipList.join(', ') || 'no-ip',
        total_mb: totalMb
      });
    }
  });

  // Sort and extract Top 10
  eligibleForTop10.sort((a, b) => b.total_mb - a.total_mb);
  const top10 = eligibleForTop10.slice(0, 10);
  const maxUsage = top10[0] ? top10[0].total_mb : 1;

  // 4. Generate HTML Content
  const timestampStr = new Date().toLocaleString();
  const reportHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Mikrotik Network Bandwidth Report</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: #f3f4f6;
      color: #1f2937;
      margin: 0;
      padding: 20px;
    }
    .container {
      max-width: 650px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 12px;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
      overflow: hidden;
      border: 1px solid #e5e7eb;
    }
    .header {
      background: linear-gradient(135deg, #1e3a8a, #0f172a);
      color: #ffffff;
      padding: 30px 24px;
      text-align: center;
    }
    .header h1 {
      margin: 0;
      font-size: 22px;
      font-weight: 700;
    }
    .header p {
      margin: 8px 0 0 0;
      font-size: 14px;
      color: #93c5fd;
    }
    .content {
      padding: 24px;
    }
    .section-title {
      font-size: 16px;
      font-weight: 700;
      color: #0f172a;
      border-bottom: 2px solid #e5e7eb;
      padding-bottom: 8px;
      margin-top: 24px;
      margin-bottom: 16px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .subnet-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 24px;
    }
    .subnet-card {
      flex: 1 1 180px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 12px;
      text-align: center;
    }
    .subnet-card-name {
      font-size: 12px;
      color: #64748b;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .subnet-card-val {
      font-size: 18px;
      font-weight: 700;
      color: #1e3a8a;
    }
    .subnet-card-devices {
      font-size: 11px;
      color: #94a3b8;
      margin-top: 4px;
    }
    .device-row {
      padding: 12px 0;
      border-bottom: 1px solid #f1f5f9;
    }
    .device-row:last-child {
      border-bottom: none;
    }
    .device-info {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
    }
    .device-name {
      font-size: 14px;
      font-weight: 600;
      color: #0f172a;
    }
    .device-ip {
      font-size: 12px;
      color: #64748b;
    }
    .device-usage {
      font-size: 14px;
      font-weight: 700;
      color: #0f172a;
    }
    .progress-bg {
      width: 100%;
      background-color: #e2e8f0;
      height: 6px;
      border-radius: 4px;
      overflow: hidden;
    }
    .progress-bar {
      height: 100%;
      background-color: #3b82f6;
      border-radius: 4px;
    }
    .footer {
      background: #f8fafc;
      padding: 16px;
      text-align: center;
      font-size: 11px;
      color: #94a3b8;
      border-top: 1px solid #e2e8f0;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Home Bandwidth Report</h1>
      <p>Mikrotik Kid Control Analytics &bull; ${timestampStr}</p>
    </div>
    
    <div class="content">
      <div class="section-title">Bandwidth by Subnet</div>
      <div class="subnet-grid">
        ${Object.keys(subnetTotals).map(name => {
          const sub = subnetTotals[name];
          const totalGb = sub.total_mb / 1024;
          return `
          <div class="subnet-card">
            <div class="subnet-card-name">${name}</div>
            <div class="subnet-card-val">${totalGb.toFixed(2)} GB</div>
            <div class="subnet-card-devices">${sub.deviceCount} devices</div>
          </div>
          `;
        }).join('')}
      </div>
      
      <div class="section-title">Top 10 Bandwidth Users</div>
      <div>
        ${top10.length === 0 ? '<div style="color: #64748b; text-align: center; padding: 20px;">No active device bandwidth to report.</div>' : ''}
        ${top10.map((dev, idx) => {
          const percent = ((dev.total_mb / maxUsage) * 100).toFixed(0);
          const totalGb = dev.total_mb / 1024;
          return `
          <div class="device-row">
            <div class="device-info">
              <div>
                <span class="device-name">${idx + 1}. ${dev.name}</span><br/>
                <span class="device-ip">IP: ${dev.ips} &bull; MAC: ${dev.mac}</span>
              </div>
              <div class="device-usage">${totalGb.toFixed(2)} GB</div>
            </div>
            <div class="progress-bg">
              <div class="progress-bar" style="width: ${percent}%"></div>
            </div>
          </div>
          `;
        }).join('')}
      </div>
    </div>
    
    <div class="footer">
      Generated automatically by Mikrotik Kid Control Reporter.
    </div>
  </div>
</body>
</html>
`;

  // Save the report file as a persistent backup preview
  const lastReportPath = path.join(DATA_DIR, 'last_report.html');
  try {
    fs.writeFileSync(lastReportPath, reportHtml, 'utf8');
    console.log(`[Batch Processor] Saved latest HTML report to ${lastReportPath}`);
  } catch (err) {
    console.error('[Batch Processor] Failed to save HTML backup:', err.message);
  }

  // 5. Send Report via SMTP
  sendEmail(reportHtml, `Home Bandwidth Report: ${new Date().toLocaleDateString()}`);

  // 6. Mark batch as done (don't delete yet - late-arriving items should be silently ignored)
  // Clean up after 5 minutes to avoid memory leaks
  activeBatches[batchId].done = true;
  setTimeout(() => { delete activeBatches[batchId]; }, 5 * 60 * 1000);
}

// SMTP sending handler
function sendEmail(htmlContent, subject) {
  const smtp = config.smtp;
  if (!smtp || smtp.host === 'smtp.example.com' || smtp.user === 'smtp-user') {
    console.log('[SMTP] SMTP credentials not configured (host is smtp.example.com or user is smtp-user). Skipping email.');
    return;
  }

  console.log(`[SMTP] Sending report email via ${smtp.host}:${smtp.port}...`);
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: {
      user: smtp.user,
      pass: smtp.pass
    }
  });

  const mailOptions = {
    from: smtp.from,
    to: smtp.to,
    subject: subject,
    html: htmlContent
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error('[SMTP] Error occurred while sending mail:', error.message);
    } else {
      console.log('[SMTP] Report email sent successfully:', info.response);
    }
  });
}

// Webhook endpoint
app.post('/webhook', (req, res) => {
  const batchId = req.headers['x-batch-id'];
  const totalCount = parseInt(req.headers['x-total-count'], 10);

  if (!batchId || isNaN(totalCount)) {
    console.warn('[Webhook] Warning: Missing X-Batch-ID or X-Total-Count headers. Ignoring request details.');
    return res.status(400).send('Missing batch metadata headers');
  }

  console.log(`[Webhook] Received batch item for ID "${batchId}". Total items expected: ${totalCount}`);

  // If batch already processed, silently ignore late-arriving items
  if (activeBatches[batchId] && activeBatches[batchId].done) {
    console.log(`[Webhook] Batch "${batchId}" already processed. Ignoring late item.`);
    return res.status(200).send('OK');
  }

  // Initialize batch structure if it's the first item
  if (!activeBatches[batchId]) {
    activeBatches[batchId] = {
      totalCount: totalCount,
      items: [],
      done: false,
      timer: setTimeout(() => {
        console.warn(`[Batch Processor] Timeout waiting for remaining items of batch "${batchId}". Processing ${activeBatches[batchId] ? activeBatches[batchId].items.length : 0} items received so far...`);
        processBatch(batchId);
      }, 300000) // 5 minute hard fallback
    };
  }

  // Push request body
  activeBatches[batchId].items.push(req.body);

  // If we have received all expected items, trigger processing immediately
  if (activeBatches[batchId].items.length >= activeBatches[batchId].totalCount) {
    console.log(`[Webhook] Batch "${batchId}" fully received (${activeBatches[batchId].items.length}/${totalCount} items). Triggering processing...`);
    clearTimeout(activeBatches[batchId].timer);
    setTimeout(() => processBatch(batchId), 100);
  }

  res.status(200).send('OK');
});

// GET endpoint to see status/files
app.get('/status', (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => f.endsWith('.html') || f.endsWith('.json'))
      .map(f => {
        const stats = fs.statSync(path.join(DATA_DIR, f));
        return { name: f, size: stats.size, mtime: stats.mtime };
      });
    res.json({
      status: 'running',
      activeBatches: Object.keys(activeBatches).map(k => ({
        id: k,
        receivedCount: activeBatches[k].items.length,
        totalCount: activeBatches[k].totalCount
      })),
      savedFilesCount: files.length,
      files: files
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Error Handling Middleware
app.use((err, req, res, next) => {
  console.error(`[Express Error Handler] Error: ${err.message}`);
  res.status(400).send(`Bad Request: ${err.message}`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] Webhook listener running on http://0.0.0.0:${PORT}`);
  console.log(`[Server] Configuration loaded from ${CONFIG_PATH}`);
  console.log(`[Server] HTML reports will be stored in: ${DATA_DIR}`);
});
