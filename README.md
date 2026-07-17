# 🚴 Bike Club Nairobi

A full-stack microservices platform for managing a cycling community — events, memberships, vouchers, payments, live chat, and newsletters. Built to demonstrate real-world distributed systems architecture.

---

## 🏗️ Architecture

```
Client (Browser)
        ↓
API Gateway (port 3000)
    ├── Rate limiting — 100 req/min per IP
    ├── JWT authentication on every request
    ├── Request logging — morgan to console + file
    └── Smart routing to correct service
        ↓
┌─────────────────────────────────────────────┐
│  Auth Service        (port 4001)            │
│  Member Service      (port 4002)            │
│  Event Service       (port 4003)            │
│  Voucher Service     (port 4004)            │
│  Payment Service     (port 4005)            │
│  Chat Service        (port 4006) WebSocket  │
│  Notification Worker (port 4007)            │
│  Admin Dashboard     (port 4008)            │
│  Newsletter Service  (port 4009)            │
│  Frontend            (port 3001)            │
└─────────────────────────────────────────────┘
        ↓
┌─────────────────────────────────────────────┐
│  MongoDB Atlas  — persistent data store     │
│  Redis          — cache + message queue     │
└─────────────────────────────────────────────┘
```

---

## ✨ Features

### Member Features
- Register and login with JWT authentication
- Browse and filter upcoming rides, campaigns, webinars and races
- Purchase vouchers for events via Stripe or MPesa
- View voucher history and status
- Live chat during events
- Webinar Q&A and sports commentary rooms
- Subscribe to newsletter
- Update profile — bike type, city, bio

### Admin Features
- Create and manage events
- View all members and manage membership status
- Issue, revoke, expire and reinstate vouchers
- View payment history and revenue stats
- Send newsletter campaigns to all subscribers
- Real-time system health monitoring
- View notification queue size and Redis memory usage

### System Features
- API Gateway with rate limiting and auth validation
- Redis cache reduces database load on every service
- Message queue for async email processing
- MPesa STK push with webhook callback
- Stripe card payments with webhook verification
- Socket.io real-time chat with message history
- Newsletter batch sending with unsubscribe management
- Soft deletes — nothing is permanently removed

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js v24 |
| Framework | Express.js |
| Database | MongoDB Atlas + Mongoose |
| Cache | Redis + ioredis |
| Queue | Redis Lists (LPUSH/RPOP) |
| Auth | JWT + bcrypt |
| Payments | Stripe + MPesa Daraja API |
| Real-time | Socket.io |
| Email | Nodemailer + Ethereal (dev) |
| Gateway | http-proxy + express-rate-limit |
| Templating | EJS |
| Styling | Bootstrap 5 |
| Dev | Nodemon + ngrok |

---

## 📁 Project Structure

```
bike-club/
├── gateway/
│   └── gateway.js
├── services/
│   ├── auth/
│   ├── members/
│   ├── events/
│   ├── vouchers/
│   ├── payments/
│   ├── chat/
│   ├── notifications/
│   ├── newsletter/
│   ├── admin/
│   └── frontend/
├── shared/
│   ├── db.js
│   ├── cache.js
│   ├── queue.js
│   └── models/
├── .env
└── package.json
```

---

## 🚀 Getting Started

### Prerequisites
- Node.js v18+
- Redis
- MongoDB Atlas account
- Stripe account (test keys)
- Safaricom Daraja account (sandbox)
- ngrok (for MPesa webhook)

### Installation

```bash
git clone <repo-url>
cd bike-club
npm install
```

### Environment Variables

```env
GATEWAY_PORT=3000
AUTH_PORT=4001
MEMBER_PORT=4002
EVENT_PORT=4003
VOUCHER_PORT=4004
PAYMENT_PORT=4005
CHAT_PORT=4006
NOTIFICATION_PORT=4007
ADMIN_PORT=4008
NEWSLETTER_PORT=4009
FRONTEND_PORT=3001

MONGO_URI=mongodb+srv://user:pass@cluster.mongodb.net/bikeclub
REDIS_HOST=localhost
REDIS_PORT=6379

JWT_SECRET=your_jwt_secret_here
JWT_EXPIRES_IN=7d

STRIPE_SECRET_KEY=sk_test_xxx
STRIPE_PUBLISHABLE_KEY=pk_test_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx

MPESA_CONSUMER_KEY=xxx
MPESA_CONSUMER_SECRET=xxx
MPESA_SHORTCODE=174379
MPESA_PASSKEY=xxx
MPESA_CALLBACK_URL=https://your-ngrok-url/payments/webhook/mpesa

EMAIL_HOST=smtp.ethereal.email
EMAIL_PORT=587
EMAIL_USER=your@ethereal.email
EMAIL_PASS=your_password
EMAIL_FROM=BikeClub <your@ethereal.email>

FRONTEND_URL=http://localhost:3001
```

### Running

```bash
npm run gateway
npm run auth
npm run members
npm run events
npm run vouchers
npm run payments
npm run chat
npm run notifications
npm run admin
npm run frontend
npm run newsletter
npm run newsletter-worker
```

### Access

```
Frontend   → http://localhost:3001
Admin      → http://localhost:4008/admin/login
Gateway    → http://localhost:3000
```

---

## 🔌 API Overview

| Service | Port | Key Routes |
|---|---|---|
| Auth | 4001 | /auth/register, /auth/login, /auth/me |
| Members | 4002 | /members/profile, /members |
| Events | 4003 | /events, /events/:id |
| Vouchers | 4004 | /vouchers/purchase, /vouchers/my |
| Payments | 4005 | /payments/stripe, /payments/mpesa |
| Chat | 4006 | WebSocket — join_room, send_message |
| Newsletter | 4009 | /newsletter/subscribe, /newsletter/send |

---

## 🗄️ Redis Key Map

```
session:{userId}               → user session (7 days)
blacklist:{token}              → invalidated tokens (7 days)
member:{userId}                → member profile (1 hour)
event:{eventId}                → single event (5 min)
events:{type}:{status}:page{n} → event list (5 min)
voucher:{code}                 → single voucher (1 min)
vouchers:member:{userId}       → member vouchers (5 min)
payments:{userId}              → payment history (5 min)
mpesa:token                    → MPesa access token (1 hour)
newsletter:subscribers         → subscriber list (5 min)
notifications                  → email job queue (LIST)
newsletter_campaign            → campaign job queue (LIST)
```

---

## 💡 Key Design Decisions

**Microservices** — each service owns its responsibility and fails independently. A chat outage doesn't affect payments.

**Redis dual purpose** — cache eliminates redundant DB queries, queue decouples slow async tasks from the request cycle.

**Async payments** — MPesa callbacks are async by nature. The pending page polls every 2 seconds until the webhook confirms payment.

**JWT blacklisting** — logout invalidates tokens instantly by storing them in Redis, without sacrificing stateless JWT benefits.

**Soft deletes** — events and vouchers are never truly deleted. Historical data is preserved for auditing and reporting.

**Service-to-service HTTP** — services call each other directly over HTTP internally, bypassing the gateway for speed.

---

## 🎯 Interview Summary

```
Built a microservices platform with 9 independent services 
behind an API gateway. The gateway handles authentication, 
rate limiting and routing. Redis serves as both cache and 
message queue. Payments are handled through Stripe and MPesa 
with async webhook callbacks. Real-time chat is powered by 
Socket.io with Redis message history. The newsletter system 
uses batch processing with Redis queues to send campaigns 
without overwhelming the email provider.
```

---

## 📄 License

MIT

---

## 👤 Author

Built by James Kemboi — Nairobi, Kenya 🇰🇪