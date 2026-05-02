# MediSync+ Backend

A secure Node.js/TypeScript REST API for hospital EMR integration.

---

## Quick Start

```bash
cp .env.example .env
# Edit .env — set DATABASE_URL, JWT_SECRET, PHI_ENCRYPTION_KEY, ANTHROPIC_API_KEY

npm install
npx prisma migrate deploy   # Run DB migrations
npx prisma generate         # Generate Prisma client
npm run dev                 # Development server with hot reload
npm run build && npm start  # Production
```

---

## 🧪 Using the Mock Hospital API (No Backend Required)

> **During Android development you do not need this backend at all.**
> The Android app includes a self-contained `MockHospitalApi` that simulates every backend response locally.

The mock lives at:
```
app/src/main/java/com/medisyncplus/data/mock/MockHospitalApi.kt
```

### What the mock replaces

| This backend endpoint | Is mocked by |
|---|---|
| `GET /api/patients/{mrn}` | `MockHospitalApi.getPatientRecord(mrn)` |
| `GET /api/patients/{mrn}/medications` | `MockHospitalApi.getMedicationOrders(mrn)` |
| `GET /api/patients/{mrn}/appointments` | `MockHospitalApi.getAppointments(mrn)` |
| `GET /api/patients/{mrn}/vital-thresholds` | `MockHospitalApi.getVitalThresholds(mrn)` |
| `GET /api/patients/{mrn}/care-plan/tasks` | `MockHospitalApi.getCarePlanTasks(mrn)` |
| `GET /api/hospital/{hospitalId}/info` | `MockHospitalApi.getHospitalInfo(hospitalId)` |
| `POST /api/sync/emr-proposals` (acknowledge) | `MockHospitalApi.acknowledgeEmrProposal(id, type)` |

### How it is used inside the Android app

**1. Hospital info → SOS dialog**

On every app launch, `MediSyncViewModel` checks whether `hospital_info` is empty in Room DB. If it is, it calls:
```kotlin
val info = MockHospitalApi.getHospitalInfo("H001")
repo.upsertHospitalInfo(HospitalInfoEntity(
    hospitalId    = info.hospitalId,
    hospitalName  = info.hospitalName,
    wardName      = info.wardName,
    wardPhone     = info.wardPhone,
    emergencyPhone = info.emergencyPhone,
    address       = info.address
))
```
The SOS dialog in `MainActivity` then reads `wardName` and `wardPhone` from the `hospitalInfo` StateFlow — fully dynamic, no hardcoded strings.

**2. Doctor-prescribed tasks → daily checklist**

`MediSyncViewModel.generateAiChecklistForToday()` and `DailyChecklistGeneratorWorker` both call:
```kotlin
val carePlan = MockHospitalApi.getCarePlanTasks(patient.mrn)
```
The care plan tasks are used to build an LLM prompt alongside the patient's real DB medication data. The AI returns a personalised JSON task list for today, which is saved as `ChecklistTaskEntity` records in Room.

**3. Doctor's Settings input**

The Settings screen ("Hospital Information" section) lets the doctor update `hospitalName`, `wardName`, and `wardPhone` directly from the app. These are saved to Room and immediately reflected in the SOS dialog. This simulates what would otherwise be a push from the hospital backend.

### Changing mock data

Edit `MockHospitalApi.kt` directly:

```kotlin
// Different hospital / ward:
fun getHospitalInfo(hospitalId: String) = HospitalInfo(
    hospitalId    = hospitalId,
    hospitalName  = "Pantai Hospital KL",
    wardName      = "Ward 6A",
    wardPhone     = "03-2296 0888",
    emergencyPhone = "999",
    address       = "8, Jalan Bukit Pantai, 59100 KL"
)

// Add a new doctor-prescribed task:
fun getCarePlanTasks(mrn: String) = listOf(
    ...existing tasks...,
    HospitalCarePlanTask(
        taskId = "T_FLUID",
        description = "Record fluid intake (max 1.5L/day)",
        timeOfDay = "AFTERNOON", iconName = "check",
        requiresVitalInput = false, vitalType = null,
        scheduledTime = "14:00", templateId = "T_FLUID"
    )
)
```

Ward/phone changes take effect on next app launch (clear Room `hospital_info` or use Settings).
Care plan task changes take effect the next day (checklist is generated once per day).

### Migrating from mock to real backend

1. Create a Retrofit interface matching the `MockHospitalApi` method signatures.
2. Register it as a `@Singleton` in `AppModule.kt` (same pattern as `LlmApiService`).
3. Inject it into `MediSyncViewModel`, `DailyChecklistGeneratorWorker`, and `EmrSyncWorker`.
4. Replace `MockHospitalApi.*` calls with the real Retrofit calls.
5. Keep `MockHospitalApi.kt` for unit tests and offline fallback.

The data class contracts (`HospitalInfo`, `HospitalCarePlanTask`, etc.) defined inside `MockHospitalApi` can be copied directly to your Retrofit DTOs — the rest of the app requires no changes.

---

## Generating Secrets

```bash
# PHI_ENCRYPTION_KEY (32 bytes = 64 hex chars)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# JWT_SECRET (64 bytes)
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## Register First Hospital

```bash
curl -X POST http://localhost:3000/api/auth/hospital/register \
  -H "X-Admin-Secret: your_admin_secret" \
  -H "Content-Type: application/json" \
  -d '{"name": "General Hospital", "address": "123 Main St"}'

# Response includes apiKey — save it, shown only once
```

---

## API Reference

### Auth Headers
| Mode | Header |
|------|--------|
| Hospital system | `X-Hospital-API-Key: msk_...` |
| Doctor dashboard | `Authorization: Bearer <jwt>` |

### Endpoints
```
POST /api/auth/hospital/register    Register hospital (admin secret required)
POST /api/auth/doctor/login         Doctor login → JWT

POST /api/patients                  Create patient
GET  /api/patients                  List patients
GET  /api/patients/:id              Patient details
POST /api/patients/:id/link-app     Link to Android app user ID

POST /api/records                   Submit care record → AI timetable → sync queue
GET  /api/records/:patientId        Get active care record

GET  /api/sync/:appUserId           Android app polls for pending items
POST /api/sync/:appUserId/ack       App acknowledges delivery
```

### Example: Submit Care Record
```json
POST /api/records
X-Hospital-API-Key: msk_abc123...

{
  "patientId": "uuid",
  "doctorId": "uuid",
  "recordType": "DISCHARGE",
  "medications": [
    {
      "name": "Furosemide", "dosage": "40mg",
      "frequency": "once_daily", "times": ["08:00"],
      "criticalMed": true, "startDate": "2026-05-02"
    }
  ],
  "adviceItems": [
    {
      "category": "EXERCISE",
      "instruction": "Walk 15-20 minutes",
      "scheduledTime": "07:30",
      "frequency": "daily", "priority": "IMPORTANT"
    },
    {
      "category": "DIET",
      "instruction": "Avoid oily and high-sodium food",
      "frequency": "daily", "priority": "IMPORTANT"
    }
  ],
  "nextAppointmentDate": "2026-05-16",
  "nextAppointmentTime": "10:00",
  "nextAppointmentType": "FOLLOW_UP"
}
```
Claude generates a structured daily timetable; the Android app receives it on the next sync poll.

---

## Docker (Production)

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist/ ./dist/
COPY prisma/ ./prisma/
RUN npx prisma generate
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

```bash
docker build -t medisync-backend .
docker run -p 3000:3000 --env-file .env medisync-backend
```
