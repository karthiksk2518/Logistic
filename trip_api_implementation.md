# Trip API Implementation

## Overview
This implementation adds backend-side trip tracking APIs that integrate with IntuTrack and persist trip metadata in PostgreSQL. It follows the existing backend architecture (Express + Drizzle ORM) and mirrors the documented IntuTrack trip endpoints.

## Implemented Backend Endpoints

### POST /api/trips/start
Starts a trip in IntuTrack, stores metadata locally, returns IntuTrack response.

**Request Body**
```json
{
  "tel": "9876543210",
  "truck_number": "WB05A2863",
  "src_lat": 19.38447762,
  "src_lng": 72.209494,
  "dest_lat": 22.985669,
  "dest_lng": 88.539783,
  "srcname": "Motherhub_SAI_4",
  "destname": "Motherhub_HRN",
  "invoice": "INV-1029",
  "eta_hrs": 12
}
```

**Response**
```json
{
  "success": true,
  "tripId": "6565ce383a9bbb2ab9d5225b",
  "consentResults": [],
  "data": {}
}
```

### POST /api/trips/submit
Submits a trip in IntuTrack, stores metadata locally, returns IntuTrack response.

**Request Body**
```json
{
  "tel": "9876543210",
  "truck_number": "WB05A2863",
  "src_lat": 19.38447762,
  "src_lng": 72.209494,
  "dest_lat": 22.985669,
  "dest_lng": 88.539783,
  "srcname": "Motherhub_SAI_4",
  "destname": "Motherhub_HRN",
  "invoice": "INV-1029",
  "eta_hrs": 12
}
```

**Response**
```json
{
  "success": true,
  "tripId": "661f58232a468475d9de144f",
  "data": {}
}
```

### PUT /api/trips/:id
Updates a trip in IntuTrack. The request body is forwarded to the IntuTrack update endpoint with `_id` set to the IntuTrack trip id.

**Request Body**
```json
{
  "tracking_state": "STOP"
}
```

**Response**
```json
{
  "success": true,
  "data": {
    "msg": "Updated Data",
    "changedData": {
      "noTrack": true,
      "trackingStoppedAt": "2023-11-28T11:26:38.947Z"
    }
  }
}
```

### POST /api/trips/:id/end
Ends a running trip in IntuTrack and marks the local trip as ENDED.

**Response**
```json
{
  "success": true,
  "data": {}
}
```

### GET /api/trips
Returns all locally stored trips sorted by `started_at` desc.

### GET /api/trips/:id/live-location
Pulls the latest location from IntuTrack status API.

**Response**
```json
{
  "lat": 13.165094,
  "lng": 77.68068,
  "speed": null,
  "lastTracked": "2023-11-28T08:47:05.843Z"
}
```

### GET /api/trips/:id/history
Fetches historical location points from IntuTrack and builds a path array.

**Response**
```json
{
  "path": [
    { "lat": 13.165094, "lng": 77.68068, "timestamp": "2023-11-28T08:47:05.843Z" }
  ],
  "totalDistance": 0,
  "totalDuration": 0
}
```

### POST /api/trips/:id/public-link
Generates and stores a public tracking link.

**Response**
```json
{
  "success": true,
  "link": "https://sct.intutrack.com/#!/public?tripId=5e62317297ed1c475c8ac19d&basic_cred=...",
  "data": {
    "link": "https://sct.intutrack.com/#!/public?tripId=5e62317297ed1c475c8ac19d&basic_cred=..."
  }
}
```

### GET /api/trips/consents?tel=XXXXXXXXXX
Fetches consent status for a phone number.

## IntuTrack Endpoints Used

### POST /login
Basic Auth with `INTUTRACK_USERNAME` and `INTUTRACK_PASSWORD`. Returns JWT token.

### POST /trips/start
Bearer token. Starts a trip.

### POST /trips/submit
Bearer token. Submits a trip.

### PUT /trips/
Basic Auth. Updates trip fields. Requires `_id` in payload.

### POST /trips/end/:tripid
Basic Auth. Ends a trip.

### POST /trips/generatepubliclink
Basic Auth. Generates public link.

### GET /status?tripId=...&limit=...
Bearer token. Returns location data for trip.

### GET /consents?tel=...
Bearer token. Returns consent data.

## Database Schema

### Table: trips

| Column | Type | Notes |
| --- | --- | --- |
| id | uuid | Primary key |
| intutrack_trip_id | text | Unique IntuTrack trip id |
| truck_number | text | Truck number |
| invoice | text | Invoice reference |
| src_lat | numeric(10,6) | Source latitude |
| src_lng | numeric(10,6) | Source longitude |
| dest_lat | numeric(10,6) | Destination latitude |
| dest_lng | numeric(10,6) | Destination longitude |
| tel | text | Phone for tracking |
| status | text | SUBMITTED, STARTED, ENDED |
| eta_hrs | integer | Estimated hours |
| tracking_state | text | START or STOP |
| started_at | timestamp | Trip start time |
| ended_at | timestamp | Trip end time |
| public_link | text | Public tracking link |
| created_at | timestamp | Row creation time |

### Relationships
No foreign keys are required for the trip metadata table. It can be linked to other domain tables externally when needed.

## Authentication Flow

### Backend API
Uses session-based authentication. All trip endpoints require a valid session (`req.session.userId`).

### IntuTrack API
1. Basic Auth to `/login` to retrieve JWT token.
2. Bearer token is cached in memory and reused until expiry.
3. Basic Auth is used for update/end/public-link endpoints as documented.

## Error Handling Strategy
Responses follow a consistent JSON shape:
```json
{
  "error": "Failed to start trip",
  "details": "..."
}
```
Known error scenarios:
- 403 from IntuTrack: invalid credentials
- 400 from IntuTrack: insufficient data
- Timeout: request aborted after `INTUTRACK_TIMEOUT`

## Configuration
Set the following environment variables in `backend/.env`:
```
INTUTRACK_BASE_URL=https://sct.intutrack.com/api/prod
INTUTRACK_USERNAME=loadsmart@uat.com
INTUTRACK_PASSWORD=UAT@loadsmart
INTUTRACK_TIMEOUT=120000
DATABASE_URL=postgres://postgres:postgres@db:5432/loadsmart
```

## Implementation Files
- backend/src/trips/trip-schema.ts
- backend/src/trips/trip-db.ts
- backend/src/trips/trip-storage.ts
- backend/src/trips/intutrack-client.ts
- backend/src/trips/trip-routes.ts
- backend/migrations/0001_intutrack_trips.sql

## Integration Notes
The new routes are exposed through `registerTripRoutes(app)` in `backend/src/trips/trip-routes.ts`. To activate them, register this function inside the main route registration flow.
