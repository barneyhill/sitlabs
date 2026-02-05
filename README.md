# sitlabs

## OligoAI API

Base URL: `https://sitlabs.org`

All endpoints return JSON unless otherwise noted. Errors return `{ "error": "message" }` with an appropriate HTTP status code.

---

### 1. Look up a gene

```
GET /api/gene/{geneName}
```

Returns parsed GFF3 gene structure including transcripts, exons, CDS regions, and UTRs.

**Example:**

```bash
curl https://sitlabs.org/api/gene/SCN8A
```

**Response:**

```json
{
  "gene": {
    "seqid": "NC_000012.12",
    "type": "gene",
    "start": 51590884,
    "end": 51951040,
    "strand": "-",
    "name": "SCN8A",
    "id": "gene:ENSG00000196876"
  },
  "transcripts": [
    {
      "id": "transcript:ENST00000627620",
      "name": "SCN8A-209",
      "start": 51590884,
      "end": 51951040,
      "strand": "-",
      "isCanonical": true,
      "exons": [ ... ],
      "cds": [ ... ],
      "utrs": [ ... ]
    }
  ],
  "minCoord": 51590884,
  "maxCoord": 51951040
}
```

---

### 2. Submit an ASO scoring job

```
POST /api/score-asos
Content-Type: application/json
```

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `geneName` | string | yes | Gene symbol (e.g. `"SCN8A"`) |
| `transcriptId` | string | yes | Transcript ID from the gene lookup (e.g. `"transcript:ENST00000627620"`) |
| `sugar` | string | yes | Sugar modification pattern (e.g. `"5xMOE,10xDNA,5xMOE"`) |
| `backbone` | string | yes | Backbone modification string, one char per linkage: `s` = PS, `d` = PD (e.g. `"sssssssssssssssssss"`) |
| `transfectionMethod` | string | yes | `"Lipofection"` or `"Gymnosis"` |
| `dosage` | number | yes | Dosage in nM (e.g. `250`) |
| `userEmail` | string | no | Email address to notify when the job completes |
| `customSequence` | string | no | Custom FASTA sequence (use with `isCustom: true`) |
| `isCustom` | boolean | no | Set `true` when providing a custom sequence instead of a gene name |

**Example:**

```bash
curl -X POST https://sitlabs.org/api/score-asos \
  -H "Content-Type: application/json" \
  -d '{
    "geneName": "SCN8A",
    "transcriptId": "transcript:ENST00000627620",
    "sugar": "5xMOE,10xDNA,5xMOE",
    "backbone": "sssssssssssssssssss",
    "transfectionMethod": "Lipofection",
    "dosage": 250
  }'
```

**Response:**

```json
{
  "jobId": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "cached": false
}
```

If an identical job has already completed, `cached` will be `true` and the existing `jobId` is returned immediately.

---

### 3. Check job status

```
GET /api/job-status/{jobId}
```

Poll this endpoint to monitor a running job.

**Example:**

```bash
curl https://sitlabs.org/api/job-status/d290f1ee-6c54-4b01-90e6-d701748f0851
```

**Response:**

```json
{ "status": "IN_PROGRESS" }
```

Possible values for `status`: `PENDING`, `IN_QUEUE`, `IN_PROGRESS`, `COMPLETED`, `FAILED`.

---

### 4. Get results (paginated)

```
GET /api/results/{jobId}?page=1&limit=100
```

Returns scored ASOs sorted by `oligoai_score` (descending). Only available once the job status is `COMPLETED`.

| Parameter | Default | Description |
|---|---|---|
| `page` | `1` | Page number (1-indexed) |
| `limit` | `100` | Results per page |

**Example:**

```bash
curl "https://sitlabs.org/api/results/d290f1ee-6c54-4b01-90e6-d701748f0851?page=1&limit=10"
```

**Response:**

```json
{
  "data": [
    {
      "position": 1042,
      "aso_sequence": "AGTCTTGACCTGTAGCTGA",
      "oligoai_score": 0.9523,
      "genomic_coordinate": "NC_000012.12:51591926",
      "gc_content": 52.6,
      "region": "Exonic (CDS)"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 221613,
    "pages": 22162
  }
}
```

---

### 5. Get job metadata

```
GET /api/results/{jobId}/meta
```

**Example:**

```bash
curl https://sitlabs.org/api/results/d290f1ee-6c54-4b01-90e6-d701748f0851/meta
```

**Response:**

```json
{
  "jobId": "d290f1ee-6c54-4b01-90e6-d701748f0851",
  "gene": "SCN8A",
  "requestedGeneName": "SCN8A",
  "transcriptId": "transcript:ENST00000627620",
  "transcriptName": "SCN8A-209",
  "chemistry": {
    "sugar": "5xMOE,10xDNA,5xMOE",
    "backbone": "sssssssssssssssssss",
    "transfectionMethod": "Lipofection",
    "dosage": 250
  },
  "totalResults": 221613,
  "createdAt": "2025-10-31T17:36:18.045Z",
  "status": "completed"
}
```

---

### 6. Download results as CSV

```
GET /api/results/{jobId}/download-csv
```

Returns the full result set as a CSV file.

**Example:**

```bash
curl -o results.csv https://sitlabs.org/api/results/d290f1ee-6c54-4b01-90e6-d701748f0851/download-csv
```

**CSV columns:** `genomic_coordinate`, `region`, `aso_sequence`, `gc_content`, `oligoai_score`

---

### 7. Check cache

```
POST /api/check-cache
Content-Type: application/json
```

Check whether a completed job already exists for the given parameters (same request body as `/api/score-asos`). Useful to avoid re-submitting duplicate work.

**Response:**

```json
{ "cachedJobId": "d290f1ee-6c54-4b01-90e6-d701748f0851" }
```

Returns `{ "cachedJobId": null }` if no cached result exists.

---

### 8. Cancel a job

```
POST /api/cancel-job/{jobId}
```

Cancels a running job and deletes any partial results.

**Example:**

```bash
curl -X POST https://sitlabs.org/api/cancel-job/d290f1ee-6c54-4b01-90e6-d701748f0851
```

---

### Typical workflow

```bash
# 1. Look up the gene to find available transcripts
curl https://sitlabs.org/api/gene/SCN8A

# 2. Submit a scoring job
JOB=$(curl -s -X POST https://sitlabs.org/api/score-asos \
  -H "Content-Type: application/json" \
  -d '{
    "geneName": "SCN8A",
    "transcriptId": "transcript:ENST00000627620",
    "sugar": "5xMOE,10xDNA,5xMOE",
    "backbone": "sssssssssssssssssss",
    "transfectionMethod": "Lipofection",
    "dosage": 250
  }')
JOB_ID=$(echo $JOB | jq -r '.jobId')

# 3. Poll until complete
while true; do
  STATUS=$(curl -s https://sitlabs.org/api/job-status/$JOB_ID | jq -r '.status')
  echo "Status: $STATUS"
  [ "$STATUS" = "COMPLETED" ] && break
  [ "$STATUS" = "FAILED" ] && { echo "Job failed"; exit 1; }
  sleep 10
done

# 4. Download results
curl -o results.csv https://sitlabs.org/api/results/$JOB_ID/download-csv
```
