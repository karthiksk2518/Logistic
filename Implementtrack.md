# 🚛 IntuTrack Trip Tracking Implementation Guide
Project: Loadsmart Backend
Stack: Node.js + PostgreSQL + Drizzle ORM
Frontend: Already Developed (DO NOT MODIFY)
Maps: Google Maps JS API already integrated

---

# 🎯 OBJECTIVE

Implement backend support for:

1. Start Trip (IntuTrack Integration)
2. End Trip
3. Fetch Trips
4. Store Trip Data in PostgreSQL
5. Track Live Trip
6. Replay Previous Trip Path on Map (Frontend already supports map)
7. Generate Public Link (optional)
8. Consent Handling

Frontend should NOT be modified.

---

# 🏗 SYSTEM ARCHITECTURE

Frontend (Already Built)
        ↓
Backend (Node.js API)
        ↓
IntuTrack APIs
        ↓
PostgreSQL (Persist Trip Metadata)
        ↓
Google Maps (Frontend uses coordinates)

---

# 🔐 ENVIRONMENT VARIABLES (.env)

Add:

INTUTRACK_BASE_URL=https://sct.intutrack.com/api/prod
INTUTRACK_USERNAME=loadsmart@uat.com
INTUTRACK_PASSWORD=UAT@loadsmart
INTUTRACK_TIMEOUT=120000

DATABASE_URL=postgres://postgres:postgres@db:5432/loadsmart

---

# 📦 INSTALL REQUIRED PACKAGES

npm install axios dotenv
npm install drizzle-orm
npm install pg

---

# 📁 PROJECT STRUCTURE (BACKEND)

Create nessury folders and files If needed 

---

# 🗄 DATABASE SCHEMA (Drizzle ORM)

Create table: trips

Columns:

- id (uuid, primary key)
- intutrack_trip_id (text)
- truck_number (text)
- invoice (text)
- src_lat (decimal)
- src_lng (decimal)
- dest_lat (decimal)
- dest_lng (decimal)
- tel (text)
- status (enum: SUBMITTED, STARTED, ENDED)
- eta_hrs (integer)
- started_at (timestamp)
- ended_at (timestamp)
- created_at (timestamp default now())

Optional:
- public_link (text)

Purpose:
We store metadata only.
Location path will be fetched dynamically from IntuTrack.

---

# 🔐 AUTHENTICATION FLOW

Step 1: Login to IntuTrack

POST /login
Basic Auth

Store returned token in memory cache.
Token contains expiry.
Refresh if expired.

Implementation Rule:
Create function:

getIntuTrackToken()

If token exists and not expired → reuse
Else → call login API

---

# 📍 START TRIP FLOW

Backend Endpoint:

POST /api/trips/start

Body from frontend:

{
  tel,
  src_lat,
  src_lng,
  dest_lat,
  dest_lng,
  truck_number,
  invoice,
  eta_hrs,
  srcname,
  destname
}

Backend Action:

1. Call IntuTrack:
   POST /trips/start
   Bearer Token

2. Handle consentResults

3. Save in PostgreSQL:
   status = STARTED
   intutrack_trip_id = tripId

4. Return:

{
  success: true,
  tripId,
  consentResults
}

Timeout must be set to 120 seconds.

---

# 🧾 SUBMIT TRIP (OPTIONAL PRE-START)

POST /api/trips/submit

Calls:
POST /trips/submit

Save returned tripId.
status = SUBMITTED

---

# 🛑 END TRIP FLOW

Backend Endpoint:

POST /api/trips/:id/end

Steps:

1. Fetch trip from DB
2. Call:
   POST /trips/end/:tripid

3. Update DB:
   status = ENDED
   ended_at = now()

Return success response.

---

# 📦 FETCH TRIPS

Backend Endpoint:

GET /api/trips

Query from DB
Return all trips sorted by started_at DESC

Frontend already supports rendering.

---

# 🛰 LIVE TRACKING

Frontend polls backend every 30 seconds.

Create backend endpoint:

GET /api/trips/:id/live-location

Implementation:

1. Call IntuTrack Fetch Trip API
2. Extract latest location
3. Return:

{
   lat,
   lng,
   speed,
   lastTracked
}

No DB storage required.

---

# 🗺 PREVIOUS TRIP PATH REPLAY

Backend Endpoint:

GET /api/trips/:id/history

Implementation:

1. Get intutrack_trip_id
2. Call Fetch Trips API with:
   starttime
   endtime

3. Extract:

tracking.path OR location logs

4. Return:

{
   path: [
      { lat, lng, timestamp }
   ],
   totalDistance,
   totalDuration
}

Frontend Google Maps will:

- Draw Polyline
- Animate marker
- Show time slider

No frontend modification required.

---

# 🔗 GENERATE PUBLIC LINK

POST /api/trips/:id/public-link

Call:
POST /trips/generatepubliclink

Store link in DB.
Return link.

---

# ⚠ ERROR HANDLING

Handle:

403 → Invalid credentials
400 → Insufficient data
Timeout → retry once

Always log full IntuTrack response.

---

# 📡 CONSENT HANDLING

Before Start Trip:

Optional call:

GET /consents?tel=xxxxxxxx

If consent = PENDING
Return suggestion to frontend.

---

# 🔄 STATUS FLOW

SUBMITTED → STARTED → ENDED

---

# 🗺 MAP INTEGRATION

Google Maps already installed.

Frontend will:

- Call backend for live-location
- Call backend for history
- Draw polyline
- Show marker animation

No Surepass needed.
Use IntuTrack only.

---

# 🧠 AI IMPLEMENTATION RULES

When implementing:

1. Do not modify frontend.
2. All IntuTrack calls go through intutrack.service.ts
3. Token must be cached.
4. Use async/await.
5. Handle 2 minute timeout.
6. Use environment variables.
7. Store only metadata in DB.
8. Never expose IntuTrack credentials to frontend.
9. Use REST standards.
10. Always log API failures.

---

# ✅ TEST FLOW

1. Login
2. Submit Trip
3. Start Trip
4. Poll Live Location
5. End Trip
6. Fetch History
7. Replay on Map

---

# 🚀 RESULT

User Can:

✔ Start trip
✔ End trip
✔ See live tracking
✔ Replay previous trip path
✔ Check total time and distance
✔ Share public tracking link

Frontend remains unchanged.

---

END OF IMPLEMENTATION GUIDE



We are using intutrack for tracking APIs ltes begin with AUTH call POST 'https://sct.intutrack.com/api/prod/login'
Username-loadsmart@uat.com
Password-UAT@loadsmart

AUTHORIZATION Basic Auth

it provides us 

Success:- 200 OK
{
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyIjoibG9hZHNtYXJ0QHVhdC5jb20iLCJjbGllbnQiOiJMb2Fkc21hcnRfVUFUIiwiY2xpZW50X2NsaWVudCI6bnVsbCwicHJpdmlsZWRnZSI6ImNsaWVudCIsInNlc3Npb25faWQiOiJsb2Fkc21hcnRAdWF0LmNvbV8xNWI2NzUwZi02MjVmLTRiMGItOWViZS1kYjRiYzVmNmExOTQiLCJzY29wZSI6IkNyZWRlbnRpYWxzIiwiaWF0IjoxNzcxNTg4NTU1LCJleHAiOjE3NzE2NzQ5NTV9.fXNpOednwfrYcE71lXxwr_lZ1-pIj85CImPsdm_H9rM",
    "user": {
        "_id": "6992feb3a06c8a45b55e1d20",
        "createdAt": "2026-02-16T11:25:39.379Z",
        "username": "loadsmart@uat.com",
        "email": "loadsmart@uat.com",
        "priviledge": "client",
        "config": {
            "missed_call": true,
            "pingrate": 900000,
            "extra_headers": [
                {
                    "title": "ANALYTICS",
                    "icon": "",
                    "path": "/analytics",
                    "show": true
                }
            ],
            "home": {
                "triplistheaders": [
                    {
                        "key": "truck_number",
                        "value": "Vehicle"
                    },
                    {
                        "key": "tel",
                        "value": "Tel"
                    },
                    {
                        "key": "srcname",
                        "value": "Source"
                    },
                    {
                        "key": "destname",
                        "value": "Destination"
                    },
                    {
                        "key": "invoice",
                        "value": "Invoice"
                    },
                    {
                        "key": "start_time",
                        "value": "Start Time"
                    },
                    {
                        "key": "reached",
                        "value": "E.T.A."
                    },
                    {
                        "key": "last_tracked",
                        "value": "Last Tracked"
                    }
                ]
            },
            "trips": {
                "submittedtripoptions": {
                    "multiple_dest_text_field": true,
                    "src_text_field": true,
                    "edit": true,
                    "dest_mandatory": true,
                    "share_link": true,
                    "epod": false
                },
                "data": {
                    "dest_locations": []
                },
                "mandatorinputfields": [
                    "srcname",
                    "truck_number"
                ],
                "newtripinputfields": [
                    {
                        "key": "truck_number",
                        "placeholder": "Truck Number",
                        "type": "text"
                    },
                    {
                        "key": "vendor",
                        "placeholder": "Transporter",
                        "type": "text"
                    },
                    {
                        "key": "lr_number",
                        "placeholder": "LR Number",
                        "type": "text"
                    },
                    {
                        "key": "client_name",
                        "placeholder": "Client Name",
                        "type": "text"
                    },
                    {
                        "key": "destname",
                        "no_show": true
                    },
                    {
                        "key": "drops",
                        "type": "array",
                        "max_length": 1,
                        "params": [
                            {
                                "key": "invoice",
                                "placeholder": "Invoice No."
                            },
                            {
                                "key": "loc",
                                "placeholder": "Destination"
                            }
                        ]
                    },
                    {
                        "key": "eta_days",
                        "placeholder": "ETA",
                        "type": "number"
                    },
                    {
                        "key": "eway_expiry",
                        "placeholder": "EWAY Bill Expiry Date",
                        "type": "date"
                    },
                    {
                        "key": "transporter_number",
                        "placeholder": "Transporter Number",
                        "type": "text"
                    },
                    {
                        "key": "vehicle_capacity",
                        "placeholder": "Vehicle Capacity",
                        "type": "list",
                        "values": [
                            {
                                "name": "0-5 ton"
                            },
                            {
                                "name": "5-10 ton"
                            },
                            {
                                "name": "10-15 ton"
                            },
                            {
                                "name": "15-20 ton"
                            },
                            {
                                "name": "20-25 ton"
                            },
                            {
                                "name": "25+ ton"
                            }
                        ]
                    }
                ]
            },
            "trip_start_form": true,
            "support_enabled": true,
            "client": "Loadsmart_UAT",
            "filter_trips_by": [],
            "tracking_tag": "PROVIDER-CONFIG",
            "location_providers": {
                "airtel": {
                    "provider": "TELENITY",
                    "service": "SMARTTRAILSHORT"
                },
                "idea": {
                    "provider": "TELENITY",
                    "service": "SMARTTRAILSHORT"
                },
                "vodafone": {
                    "provider": "TELENITY",
                    "service": "SMARTTRAILSHORT"
                },
                "jio": {
                    "provider": "JIO",
                    "service": "DEFAULT"
                },
                "bsnl": {
                    "provider": "TELENITY",
                    "service": "SMARTTRAIL"
                }
            },
            "reports": {},
            "map": {
                "light_theme": true
            },
            "theme": {
                "light": true
            },
            "alert": [
                {
                    "type": [
                        "CONSENT_PENDING",
                        "TICKET_CHAT"
                    ]
                }
            ],
            "account": null
        },
        "created_by": "ops_uc"
    }
}

Failure :- 403 Forbidden
{
    "errorCode": 403,
    "msg": "Invalid Credentials. Attempts remaining - 4.",
    "requestData": {
        "name": "loadsmart@uat.com",
        "pass": "UAT@loa"
    }
}
















Consent
AUTHORIZATION
Basic Auth
This folder is using Basic Auth from collectionSCT External APIs
GET Check Consent Status
https://sct.intutrack.com/api/prod/consents?tel=xxxxxxxxxx
Overview
This endpoint retrieves the trackable status of cells and sends consent SMSs to the provided cell numbers.

Authorization
Basic Authorization with API credentials provided

Bearer Authorization with token fetched from the login endpoint

Notes
This API can take a long time to respond, as it depends to multiple third parties (e.g. Service providers like Airtel etc..). So either increase the timeout when you're sending this request (Suggested would be 2 min) or handle the response in case a timeout error occurs.
AUTHORIZATION
Basic Auth
This request is using Basic Auth from collectionSCT External APIs
PARAMS
tel
xxxxxxxxxx

Comma separated phone numbers, if only one then supply just one telephone number without comma



Example Request
Check Consent Status

REQ:- curl --location 'https://sct.intutrack.com/api/prod/consents?tel=8047092640'


RES:-[
  {
    "result": {
      "message": "Consent recorded",
      "number": "8047092640",
      "operator": "airtel",
      "consent": "PENDING",
      "consent_suggestion": "Send 's' to 5114040"
    },
    "code": 200
  }
]















POST
Start Trip
https://sct.intutrack.com/api/prod/trips/start
Overview
This endpoint is for starting a trip i.e. start tracking of a trip

Required Body Parameters
Depending on the mode of tracking required, the first param may be one of the following:

tel (String) - Comma separated cell numbers for tracking without the country code, for conventional SIM-based tracking of a mobile phone

device_id (String) - the device ID of the use-and-throw device you wish to use (see "Fetch All" endpoint in Devices folder). In this case, the tel (M2M SIM number to be tracked) will be fetched automatically from the device ID.

src (String) - Comma separated coordinates for source location i.e. 12.7445, 23.223

dest (String) - Comma separated coordinates for destination location i.e. 12.7445, 23.223

Optional Body Parameters
ETA

eta_days (Number) A number representing no. of days it will take for the truck to reach destination from source

eta_time (Number) Epoch value of the expected time to reach the destination e.g. 1594023550916 for Jul 06 2020 13:49:10 GMT+0530

eta_hrs (Number) No. of hours it'll take to reach the destination

invoice (String)

srcname (String) Source name to show on the dashboard e.g. Bangalore

destname (String) Destination name to show on the dashboard e.g. Delhi

srcaddress (String) Source address

destaddress (String) Destination address

truck_number (String)

vendor (String)

You can pass in your custom parameters as well by using a prefix custom_ in the key.

drops(Array):

Notes

This API can take a long time to respond, as it depends on multiple third parties (e.g. Service providers like Airtel etc..) to give the current consent status/suggestion in response. So either increase the timeout when you're sending this request (Suggested would be 2 min) or handle the response in case a timeout error occurs. This long response time can be avoided if you don't use the consent_suggestion from the response, if that's the case let us know over the email.
Ocean Trip
Body Params:

trip_type -> "Sea" // Fixed string, to distinguish between ocean and other type of trips

container_number -> Container Number // String

shipping_line_scac_code -> SCAC Code of shipping line


Start Trip with Truck number and invoice 
REQ :- 
curl --location 'https://sct.intutrack.com/api/prod/trips/start' \
--header 'Content-Type: application/json' \
--data '{
	"tel": "9723663688",
	"src": "43.1938516,-71.5723953",
	"dest": "22.895262296256757,72.59992581956229",
	"drops": [
		{
			"loc": [
				22.895262296256757,
				72.59992581956229
			],
			"name": "KHIMJI RAMDAS INDIA PVT. LTD., 3780/83, PATEL ESTATE, BAJRANG LANE, AHMEDABAD"
		}
	],
	"srcname": "Kheda",
	"eta_hrs": 50,
	"destname": "AHMEDABAD",
	"truck_number": "GJ 18 X 9482",
	"invoice": "XYZ123"
}'

RES:- {
  "consentResults": [
    {
      "number": "7354670095",
      "operator": "airtel",
      "consent": "ALLOWED",
      "consent_suggestion": null
    }
  ],
  "msg": "Trip started",
  "requestdata": {
    "tel": [
      "7354670095"
    ],
    "src": [
      "12.77",
      "77.12"
    ],
    "dest": [
      "13.334",
      "35.434"
    ],
    "started_by": "lovepreet"
  },
  "tripId": "5c94c6f5f8f3812f67ba42dd"
}

Start trip with concent suggesion 
REQ:-
curl --location 'https://sct.intutrack.com/api/prod/trips/start' \
--header 'Content-Type: application/json' \
--data '{
	"tel": "9711325880",
	"src": "43.1938516,-71.5723953",
	"dest": "22.895262296256757,72.59992581956229",
	"drops": [
		{
			"loc": [
				22.895262296256757,
				72.59992581956229
			],
			"name": "KHIMJI RAMDAS INDIA PVT. LTD., 3780/83, PATEL ESTATE, BAJRANG LANE, AHMEDABAD"
		}
	],
	"srcname": "Kheda",
	"eta_hrs": 50,
	"destname": "AHMEDABAD",
	"truck_number": "GJ 18 X 9482",
	"invoice": "XYZ123"
}'
RES:-
{
  "consentResults": [
    {
      "number": "9711325880",
      "operator": "vodafone",
      "consent": "NOT REGISTERED IN MISSEDCALLALERT",
      "consent_suggestion": "GIVE A MISSED CALL TO 08033946348"
    }
  ],
  "msg": "Trip started",
  "requestdata": {
    "tel": [
      "9711325880"
    ],
    "src": [
      "12.77",
      "77.12"
    ],
    "dest": [
      "13.334",
      "35.434"
    ],
    "started_by": "lovepreet"
  },
  "tripId": "5c94dba4f8f3812f67ba573c"
}

Start trip with Insufficient Data
REQ:- 

curl --location 'https://sct.intutrack.com/api/prod/trips/start' \
--header 'Content-Type: application/json' \
--data '{
    "src": "43.1938516,-71.5723953"
}'



RES:- {
  "errorCode": 400,
  "msg": "Insufficient Data",
  "requestdata": {
    "src": "43.1938516,-71.5723953",
    "started_by": "lovepreet",
    "tracking_tag": "ALT-1",
    "truck_number": null,
    "isDelayed": false,
    "isAtHalt": false,
    "tracking": {
      "time_of_day_constraints": {
        "from": 21600000,
        "to": 79200000
      }
    }
  }
}




















POST
Submit Trip
https://sct.intutrack.com/api/prod/trips/submit
Overview
This endpoint is used to submit trip information to the IntuTrack platform. It is particularly useful for setting up prerequisites before starting the actual trip, such as obtaining consent approvals, generating LR numbers, and more.

Required Body Parameters
tel (String): Comma-separated cell numbers for tracking without the country code.

src (String): Comma-separated coordinates for the source location (e.g., 12.7445, 23.223).

dest (String): Comma-separated coordinates for the destination location (e.g., 12.7445, 23.223).

Optional Body Parameters
ETA (Expected Time of Arrival)

eta_days (Number): Number representing the number of days it will take for the truck to reach the destination from the source.

eta_time (Number): Epoch value of the expected time to reach the destination (e.g., 1594023550916 for Jul 06 2020 13:49:10 GMT+0530).

eta_hrs (Number): Number of hours it'll take to reach the destination.

Additional Information

invoice (String): Invoice related to the trip.

srcname (String): Source name to display on the dashboard (e.g., Bangalore).

destname (String): Destination name to display on the dashboard (e.g., Delhi).

srcaddress (String): Source address.

destaddress (String): Destination address.

truck_number (String): Truck number.

vendor (String): Vendor information.

Custom Parameters

You can pass in your custom parameters using a prefix custom_ in the key.
Drops (Array)

An array of drop locations, each containing:

name (String): Location name.

loc (Array): Array with latitude and longitude of the drop location.

lr_number (String, Optional): LR number associated with the drop.

invoice (String, Optional): Invoice number associated with the drop.


REQ:- 
curl --location 'https://sct.intutrack.com/api/prod/trips/submit' \
--header 'Content-Type: application/json' \
--header 'Authorization: Bearer {{token}}' \
--data '{
	"tel": "9723663688",
	"src": "43.1938516,-71.5723953",
	"dest": "22.895262296256757,72.59992581956229",
	"drops": [
		{
			"loc": [
				22.895262296256757,
				72.59992581956229
			],
			"name": "KHIMJI RAMDAS INDIA PVT. LTD., 3780/83, PATEL ESTATE, BAJRANG LANE, AHMEDABAD",
			"invoice": "XYZ124"
		}
	],
	"srcname": "Kheda",
	"destname": "AHMEDABAD",
	"truck_number": "GJ 18 X 9482",
	"invoice": "XYZ123"
}'

RES:- {
  "tripId": "5e8b6e31ce5504636375c21a"
}




















GET
Fetch Trips
https://sct.intutrack.com/api/prod/trips?submit=true&addConsents=true&pageno=1&pagesize=200&starttime=1659292200000&endtime=1660069799059
Overview
This endpoint is used to fetch trips sorted by their trip start time. It supports various query parameters for customization.

Response
The API response will contain information about the fetched trips based on the specified criteria.

Important: Customize the query parameters according to your specific requirements.

AUTHORIZATION
Basic Auth
This request is using Basic Auth from collectionSCT External APIs
PARAMS
submit
true

Indicates to include submitted trips in the results.

addConsents
true

Indicates to include consent information in the results

pageno
1

Page number for paginated results

pagesize
200

Number of items to include per page

starttime
1659292200000

Start time in epoch format to filter trips

endtime
1660069799059

End time in epoch format to filter trips

REQ:- curl --location 'https://sct.intutrack.com/api/prod/trips?submit=true&addConsents=true&pageno=1&pagesize=200'

























POST
End Trip
https://sct.intutrack.com/api/prod/trips/end/:tripid
Overview
This endpoint is used to end a running trip.

Path Variable
tripid (String): The unique identifier for the trip. You obtain this identifier as a response after starting/submitting the trip and is referenced as _id in the fetch trip API.
Response
The API response will indicate the successful completion of ending the specified trip.

Important: Replace 5b2a2d7e6c7f644ce93e8b9f in the example request with the actual trip ID you obtained from starting or submitting the trip.

AUTHORIZATION
Basic Auth
This request is using Basic Auth from collectionSCT External APIs
PATH VARIABLES
tripid
5b2a2d7e6c7f644ce93e8b9f

Trip Id which you get after starting/submitting the trip

Example Request
Invalid Credentials
View More
curl
curl --location --request POST 'https://sct.intutrack.com/api/prod/trips/end/5b2a2d7e6c7f644ce93e8b9f'
403 Forbidden
Example Response
Body
Headers (10)
View More
json
{
  "errorCode": 403,
  "msg": "Invalid credentials",
  "requestData": {
    "x-forwarded-for": "49.207.225.142",
    "x-real-ip": "49.207.225.142",
    "x-real-port": "43052",
    "host": "sct.intutrack.com",
    "connection": "close",
    "content-length": "0",
    "user-agent": "PostmanRuntime/7.29.2",
    "accept": "*/*",
    "accept-encoding": "gzip, deflate, br"
  }
}
POST
Generate Public Link
https://sct.intutrack.com/api/prod/trips/generatepubliclink
Overview
This endpoint is used to generate a public link that can be embedded onto your platform or shared with your clients.

Required Body Parameters
tripId (String): TripId, which is received in the response of the trip start API.

Example: "5e62317297ed1c475c8ac19d"



Successfull End Trip 
REQ:- curl --location --request POST 'https://sct.intutrack.com/api/prod/trips/end/64183e6afec12281f673c8cb'

RES :- {
  "msg": "Trip Completed",
  "tripId": "64183e6afec12281f673c8cb"
}


Already Ended Trip 
REQ:- curl --location --request POST 'https://sct.intutrack.com/api/prod/trips/end/64183e6afec12281f673c8cb'
RES:- {
  "msg": "Trip has already ended",
  "tripId": "64183e6afec12281f673c8cb"
}

Invalid Trip Id 
REQ:- curl --location --request POST 'https://sct.intutrack.com/api/prod/trips/end/64183e6afec12281f673c8'
RES :- {
  "msg": "No trip exists",
  "tripId": "64183e6afec12281f673c8"
}














POST
Generate Public Link
https://sct.intutrack.com/api/prod/trips/generatepubliclink
Overview
This endpoint is used to generate a public link that can be embedded onto your platform or shared with your clients.

Required Body Parameters
tripId (String): TripId, which is received in the response of the trip start API.

Example: "5e62317297ed1c475c8ac19d"


REQ:- curl --location 'https://sct.intutrack.com/api/prod/trips/generatepubliclink' \
--header 'Content-Type: application/json' \
--data '{
    "tripId": "5e62317297ed1c475c8ac19d"
}'

RES:- {
  "link": "https://sct.intutrack.com/#!/public?tripId=5e62317297ed1c475c8ac19d&basic_cred=VUNlQUpqRkwwWWZxSjQxZlFzbGNPQkJWQXNRU2h0cnZGZ0ZlZGJaQ1htcU5DdUkwTHNiOHBYaHNTR0hLTzhsRzo1OEFkcFNidlVsRUJ0b29vQ3hBVFJPRjZLTGNmY3dOcEJDcjZ0M1hKYnRoRWxSZnFlbHZPVzFkTlMxaWV2ZGNi"
}














