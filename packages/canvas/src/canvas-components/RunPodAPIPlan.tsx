export default function RunPodAPIPlan() {
  return (
    <div style={{
      fontFamily: 'monospace',
      fontSize: 12,
      lineHeight: 1.6,
      color: '#1a1a1a',
      padding: 20,
      background: '#fafaf8',
      borderRadius: 8,
      border: '1px solid #e0ddd8',
      width: '100%',
      height: '100%',
      overflowY: 'auto',
      boxSizing: 'border-box' as const,
    }}>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 2 }}>RunPod GPU Trigger API</div>
      <div style={{ fontSize: 11, color: '#888', marginBottom: 14 }}>capture device → trigger GPU job → poll result · POC Plan</div>

      <div style={{ background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 5, padding: '6px 10px', fontSize: 11, marginBottom: 14 }}>
        ⚠ CRITICAL: Cloudflare proxy = 100s timeout. Video jobs blow past it. Async pattern mandatory.
      </div>

      <div style={{ fontWeight: 700, borderBottom: '1px solid #e0ddd8', paddingBottom: 3, marginBottom: 8 }}>Phase 1 — FastAPI on existing pod (~30 min)</div>
      <div style={{ fontSize: 11, marginBottom: 6 }}>URL: https://&#123;POD_ID&#125;-8000.proxy.runpod.net</div>
      <pre style={{ background: '#1e1e1e', color: '#d4d4d4', borderRadius: 5, padding: '8px 12px', fontSize: 11, margin: '0 0 8px' }}>{`POST /ingest
  { media_url, job_type }
  → { job_id }   ← immediate

GET /status/{job_id}
  → { status, result_url }`}</pre>

      <div style={{ fontSize: 11, marginBottom: 8 }}>
        <b>Gotchas:</b>
        <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
          <li>Bind to 0.0.0.0:8000, NOT 127.0.0.1</li>
          <li>No auth built in — add bearer token middleware</li>
          <li>Proxy URL changes on pod restart</li>
          <li>Expose port in RunPod dashboard first</li>
        </ul>
      </div>

      <div style={{ fontWeight: 700, borderBottom: '1px solid #e0ddd8', paddingBottom: 3, margin: '10px 0 8px' }}>Phase 2 — Serverless (production)</div>
      <pre style={{ background: '#1e1e1e', color: '#d4d4d4', borderRadius: 5, padding: '8px 12px', fontSize: 11, margin: '0 0 6px' }}>{`POST api.runpod.ai/v2/{ENDPOINT_ID}/run
  Authorization: Bearer {API_KEY}
  → { id, status: IN_QUEUE }

GET /v2/{ENDPOINT_ID}/status/{id}
  → { status: COMPLETED, output }`}</pre>
      <div style={{ fontSize: 11, color: '#555', marginBottom: 12 }}>Built-in queue + auto-scale. min_workers avoids cold starts.</div>

      <div style={{ fontWeight: 700, borderBottom: '1px solid #e0ddd8', paddingBottom: 3, margin: '10px 0 8px' }}>Next steps</div>
      <ol style={{ fontSize: 11, margin: 0, paddingLeft: 16 }}>
        <li>Expose port 8000 in RunPod pod config</li>
        <li>Add FastAPI server (POST /ingest + GET /status)</li>
        <li>Wire capture device to POST on save</li>
        <li>Test async poll loop end-to-end</li>
        <li>Migrate to Serverless when scaling</li>
      </ol>
    </div>
  );
}
