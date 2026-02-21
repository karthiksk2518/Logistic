# LoadSmart

Full-stack app with a React (Vite) frontend and an Express backend.

## Prerequisites
- Docker Desktop or Docker Engine with Docker Compose
- Optional for local (non-Docker) run: Node.js 20+

## Run with Docker (recommended)
1. From this directory:

```bash
docker compose up --build
```

2. Open:
- Frontend: http://localhost:5173
- Backend: http://localhost:5000
- Database: localhost:5432 (postgres/postgres, database loadsmart)

To stop:

```bash
docker compose down
```

To reset data:

```bash
docker compose down -v
```

## Environment variables
- Copy backend/.env.example to backend/.env and fill real values as needed.
- Optional: set OPENAI_API_KEY in your shell to enable AI features.

## Run without Docker (local)
1. Create a PostgreSQL database and user, then set DATABASE_URL in backend/.env.
2. Apply SQL files to initialize the database:
   - backend/docker/init/0000_extensions.sql
   - backend/migrations/0000_confused_the_liberteens.sql
   - backend/docker/init/0002_session.sql
3. Start the backend:

```bash
cd backend
npm install
npm run dev
```

4. Start the frontend in a new terminal:

```bash
cd frontend
npm install
npm run dev
```

5. Open:
- Frontend: http://localhost:5173
- Backend: http://localhost:5000
