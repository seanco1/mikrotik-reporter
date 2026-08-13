# Mikrotik KidControl Bandwidth Reporter 📊

A Node.js service that receives aggregated bandwidth usage reports from Mikrotik routers running RouterOS scripts (such as Kid Control data), groups total consumption by configured subnets/VLANs, highlights top bandwidth consumers, and sends formatted HTML email summaries via SMTP.

---

## ✨ Features

- 📩 **HTTP Webhook Collector**: Accepts batch HTTP POST requests from Mikrotik RouterOS scripts with custom headers (`X-Batch-ID`, `X-Total-Count`).
- ⚡ **Batch Processing & Fallback**: Groups chunked RouterOS payload items into unified reports, with automatic timeouts to handle dropped packet chunks.
- 🌐 **Subnet & VLAN Aggregation**: Categorizes device IPs into user-defined subnets (e.g., *Infrastructure*, *Guests*, *IoT*, *Cameras*) and calculates total MB consumption per subnet.
- 🏆 **Top Usage Tracking & Exclusion Filtering**: Ranks top bandwidth-consuming devices while allowing specific IP subnets to be excluded from top lists.
- 📧 **Beautiful HTML Email Reports**: Sends styled, responsive HTML email summaries with visual bandwidth bars via Nodemailer SMTP.
- 💾 **Local Report Archiving**: Saves generated HTML and JSON data payloads locally to disk (`./data/`).
- 🔍 **Status API Endpoint**: Exposes a GET `/status` endpoint to monitor current batch queues and saved reports.

---

## 🛠️ Installation & Setup

### Prerequisites

- **Node.js**: v14+ installed on your server or container.
- **Mikrotik Router**: RouterOS device with Kid Control or custom accounting scripts enabled.

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/seanco1/mikrotik-reporter.git
cd mikrotik-reporter
npm install
```

### 2. Configuration

Create your configuration file from the example template:

```bash
cp config.json.example config.json
```

Edit `config.json` with your server settings, subnets, and SMTP server details:

```json
{
  "port": 5000,
  "batchTimeoutMs": 10000,
  "smtp": {
    "host": "smtp.gmail.com",
    "port": 587,
    "secure": false,
    "user": "your-email@gmail.com",
    "pass": "your-app-password",
    "from": "your-email@gmail.com",
    "to": "recipient@example.com"
  },
  "subnets": [
    { "name": "Infrastructure", "cidr": "172.18.141.0/24" },
    { "name": "Home Devices", "cidr": "172.18.139.0/24" },
    { "name": "Guests", "cidr": "172.31.40.0/24" },
    { "name": "IoT", "cidr": "172.18.143.0/24" }
  ],
  "excludeFromTop10": [
    "172.18.141.0/24"
  ]
}
```

---

## 🚀 Running the Service

### Direct Execution

```bash
npm start
```

### Running in Background with PM2

```bash
npm install -g pm2
pm2 start server.js --name "mikrotik-reporter"
pm2 save
```

---

## 📡 API Endpoints & Usage

### 1. Webhook Endpoint (`POST /webhook`)

Mikrotik RouterOS sends batch items via JSON HTTP POST.

**Required Headers:**
- `X-Batch-ID`: Unique string identifier for the batch report execution (e.g., `batch-1700000000`).
- `X-Total-Count`: Total number of chunked HTTP requests expected in this batch.

**Sample Request Body (sent per device by Mikrotik):**
```json
{
  "name": "John-Laptop",
  "mac": "AA:BB:CC:DD:EE:FF",
  "ips": "172.18.139.45",
  "total_mb": 1540.5
}
```

### 2. Status & Health Check (`GET /status`)

Inspect active processing batches and archived report counts:

```bash
curl http://localhost:5000/status
```

---

## 🤖 RouterOS Integration Example

On your Mikrotik Router, you can use a script to loop over `/ip kid-control device` or host leases and send usage data to the webhook:

```routeros
:local batchId ("batch-" . [/system clock get date] . "-" . [/system clock get time]);
:local totalCount 1;

/tool fetch url="http://YOUR_SERVER_IP:5000/webhook" \
  http-method=post \
  http-header-field="Content-Type: application/json,X-Batch-ID: $batchId,X-Total-Count: $totalCount" \
  http-data="{\"name\":\"DeviceName\",\"mac\":\"00:00:00:00:00:00\",\"ips\":\"192.168.88.10\",\"total_mb\":250.5}"
```

---

## 📄 License

[MIT](LICENSE) - Free to use and modify!
