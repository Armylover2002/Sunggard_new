# CourierGo — On-Demand Courier & Logistics Platform

CourierGo is an end-to-end, enterprise-grade on-demand parcel courier and logistics platform. It provides dedicated interfaces and backend services for customers, delivery partners, merchants/sellers, and platform administrators.

---

## Architecture Overview

```
CourierGo/
├── backend/                  # Node.js / Express API & Microservices
│   ├── app/                  # Application domains, controllers, models & services
│   ├── config/               # Database, Redis, and service configuration
│   ├── middleware/           # Auth, validation, rate limiting & error handling
│   ├── routes/               # RESTful API route definitions
│   └── index.js              # Server entry point
├── frontend/                 # React (Vite) Single-Page Application
│   ├── src/
│   │   ├── modules/
│   │   │   ├── admin/        # Platform operations & admin console
│   │   │   ├── customer/     # Customer parcel booking & tracking
│   │   │   ├── delivery/     # Delivery rider application & workflows
│   │   │   └── seller/       # Merchant consignment dashboard
│   │   ├── shared/           # Design system, reusable UI tokens & utilities
│   │   └── App.jsx           # Root application router
│   └── vite.config.js        # Vite configuration & build optimization
└── render.yaml               # Multi-service cloud deployment configuration
```

---

## Core Capabilities

- **Customer Experience**: Instant parcel booking, multi-point pickup & drop routing, live rider tracking on Google Maps, secure OTP delivery handshakes, digital wallet, and flexible payment options (Online & COD).
- **Delivery Partner App**: Real-time delivery broadcast queue, state-machine driven job progression, turn-by-turn routing, cash-on-delivery reconciliation, and earnings/payout tracking.
- **Merchant / Seller Hub**: Bulk parcel creation, waybill generation, real-time shipment monitoring, and returns management.
- **Admin Control Plane**: Fleet monitoring, user verification & onboarding, commission rules, financial ledger audits, and system configuration.

---

## Technology Stack

### Frontend
- **Framework**: React 18 with Vite
- **Styling**: Tailwind CSS & Vanilla CSS design system tokens
- **Animations**: `motion/react` & `animejs`
- **Real-Time Communication**: Socket.IO Client
- **Mapping**: Google Maps JavaScript API & Places Autocomplete

### Backend
- **Runtime & Framework**: Node.js & Express.js
- **Database**: MongoDB with Mongoose ODM
- **Caching & Queues**: Redis with Bull Queue
- **Real-Time Engine**: Socket.IO for live location broadcasts & status alerts
- **Logging & Observability**: Structured JSON logging (Winston), Prometheus metrics
- **Third-Party Services**:
  - **Payments**: Razorpay & PhonePe Gateway integration
  - **Media**: Cloudinary signed uploads
  - **Push Notifications**: Firebase Cloud Messaging (FCM)
  - **SMS/OTP**: SMS India Hub / DLT gateway

---

## Getting Started

### Prerequisites
- Node.js (v18+ recommended)
- MongoDB instance (local or MongoDB Atlas)
- Redis instance (local or hosted)

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/ujjawal2700/SunGguard.git
   cd SunGguard
   ```

2. **Backend Setup**:
   ```bash
   cd backend
   cp .env.example .env
   # Update .env with your MongoDB, Redis, and API credentials
   npm install
   npm run dev
   ```

3. **Frontend Setup**:
   ```bash
   cd ../frontend
   npm install
   npm run dev
   ```

The frontend application will start on `http://localhost:5173` and proxy API calls to the backend on `http://localhost:7000`.

---

## Process Roles (Backend)

The backend supports multi-process orchestration via `PROCESS_ROLE`:

| Role | Description |
|---|---|
| `all` | Runs API, queue worker, and scheduler in a single process (development). |
| `api` | Runs HTTP API & WebSocket endpoints (production web replicas). |
| `worker` | Processes asynchronous background Bull queues (notifications, payouts). |
| `scheduler` | Runs recurring cron and auto-cancellation workers. |

---

## Deployment

The repository includes a ready-to-deploy [`render.yaml`](render.yaml) specification defining:
- Key-Value / Redis instance
- Scalable Web API service
- Background worker instance
- Scheduled job executor

---

## License

This project is proprietary and confidential. All rights reserved.
