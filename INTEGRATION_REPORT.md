# Integration Report

## 1. Frontend-Backend Architecture
The project follows a **Separated Frontend-Backend Architecture**:
- **Frontend**: A React application (Vite) located in `frontend/`. It handles the UI, state management (TanStack Query), and client-side validation (Zod).
- **Backend**: An Express.js server located in `backend/`. It handles API requests, authentication, business logic, and database interactions.

### Directory Structure
```
Version1/Versionbuild/
├── frontend/          # Client-side application
│   ├── src/
│   │   ├── lib/       # API hooks (api-hooks.ts), Query Client
│   │   └── ...
│   ├── vite.config.ts # API Proxy configuration
│   └── ...
├── backend/           # Server-side application
│   ├── src/
│   │   ├── routes.ts  # API definitions
│   │   ├── db.ts      # Database connection (Pool)
│   │   └── ...
│   ├── .env           # Environment variables
│   └── ...
└── ...
```

## 2. Integration Points

### A. API Proxy (Development)
In development, the frontend communicates with the backend via a Vite proxy to avoid CORS issues.
- **Config**: `frontend/vite.config.ts`
- **Rule**: Requests to `/api` are forwarded to `http://localhost:5000`.
- **Production**: The backend is configured to serve static files (`serveStatic` in `index.ts`), meaning the frontend and backend will be served from the same origin, eliminating CORS requirements.

### B. Data Flow
1.  **Request Initiation**: User action triggers a hook in `frontend/src/lib/api-hooks.ts` (e.g., `useLoads()`).
2.  **Client-Side Caching**: `TanStack Query` checks the cache. If stale/missing, it fetches.
3.  **Transport**: Request sent to `/api/loads`.
4.  **Proxy/Network**: Forwarded to Backend port 5000.
5.  **Middleware**: `requireAuth` in `backend/src/routes.ts` checks the session.
6.  **Processing**: Route handler calls `workflow-service.ts` or `storage.ts`.
7.  **Database**: `drizzle-orm` executes SQL via `pg.Pool` (see Database section).
8.  **Response**: JSON data returned to frontend.

## 3. Configuration & Environment

### Environment Variables (`backend/.env`)
The backend is configured with the following keys:
- `PORT`: Server port (default: 5000).
- `DATABASE_URL`: Connection string for PostgreSQL.
- `NODE_ENV`: `development` or `production`.
- `OPENAI_API_KEY`: API key for AI features.

*Note: The frontend does not currently use a `.env` file, as it relies on the proxy and relative paths.*

## 4. Authentication & Security

### Session-Based Authentication
- **Mechanism**: `express-session` with `connect-pg-simple` store.
- **Persistence**: Sessions are stored in the `session` table in PostgreSQL.
- **Cookies**:
    - `httpOnly`: Yes (prevents XSS access to cookie).
    - `secure`: Enabled in Production (`NODE_ENV=production`).
    - `sameSite`: `lax` (dev) / `none` (prod).

### Security Measures
- **Password Hashing**: SHA-256 (Note: Consider upgrading to bcrypt/argon2 for higher security).
- **Input Validation**: Zod schemas used in both Frontend (form validation) and Backend (API payload validation).
- **CORS**: Not explicitly enabled in middleware because:
    - Dev: Handled by Vite Proxy.
    - Prod: Same-origin serving.

## 5. PostgreSQL RDS Integration

### Connection Details
- **Target Endpoint**: `logistics-postgres-v1.cfy0yiqou4lk.ap-south-1.rds.amazonaws.com`
- **Port**: 5432
- **User**: `postgres`
- **Database**: `postgres`

### Connection Pooling (`backend/src/db.ts`)
The application uses `pg.Pool` for efficient connection management:
- **Max Connections**: 10 (Concurrent requests handled).
- **Idle Timeout**: 30000ms (30s).
- **Connection Timeout**: 10000ms (10s).

### RDS Specific Recommendations
To ensure a stable connection to AWS RDS:
1.  **SSL/TLS**: AWS RDS typically mandates or prefers SSL connections. The current `db.ts` might need `ssl: { rejectUnauthorized: false }` added to the `Pool` config if not using a specific CA certificate.
2.  **Latency**: Ensure the backend server is in the same region (ap-south-1) as the RDS instance to minimize latency.
3.  **Schema Migration**: The application uses Drizzle ORM. Ensure migrations are run against the new RDS instance using `npm run push` or similar before starting the app.

### Proposed Configuration Update
Update `backend/src/db.ts` to handle production SSL:

```typescript
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  allowExitOnIdle: false,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined
});
```

## 6. Error Handling
- **Frontend**: `useQuery` exposes `isError` and `error` states. UI components display error toasts or fallback messages.
- **Backend**:
    - Global error handler in `index.ts` catches unhandled exceptions.
    - Async errors are caught and passed to `next(err)`.
    - Returns standardized JSON: `{ message: string }`.

## 7. Next Steps
1.  Update `backend/.env` with the RDS connection string.
2.  Update `backend/src/db.ts` to support SSL for RDS.
3.  Run database migrations against the RDS instance.
4.  Deploy backend to a production environment (e.g., EC2, Replit, Vercel) with access to the RDS VPC.
