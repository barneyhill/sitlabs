// sitlabs/server.ts

import { z } from 'zod';
import path from 'path';
import runpodSdk from "runpod-sdk";

// --- Zod Schemas ---
const ScoreAsosBodySchema = z.object({
  geneName: z.string().min(1),
  transcriptId: z.string().min(1),
  sugar: z.string().min(1),
  backbone: z.string().min(1),
  topN: z.number().positive().optional(),
});

// --- Type Definitions ---
interface GffFeature {
  seqid: string; type: string; start: number; end: number; strand: string;
  attributes: Record<string, string>; id?: string; parentId?: string; name?: string;
  exons?: GffFeature[]; cds?: GffFeature[]; utrs?: GffFeature[]; isCanonical?: boolean;
}

// --- RunPod SDK Initialization ---
const RUNPOD_API_KEY = Bun.env.RUNPOD_API_KEY;
if (!RUNPOD_API_KEY) {
    console.error("FATAL: RUNPOD_API_KEY environment variable is not set. The server will not start.");
    process.exit(1);
}
const RUNPOD_ENDPOINT_ID = "uni6qber6ldu7k";
const runpod = runpodSdk(RUNPOD_API_KEY);
const endpoint = runpod.endpoint(RUNPOD_ENDPOINT_ID);

// --- In-Memory Store for Job Metadata (THE FIX) ---
const jobMetadataStore = new Map<string, { gene: GffFeature, transcript: GffFeature, topN?: number, targetRna: string }>();


// --- Main Server Logic ---
console.log("Starting SITLabs server with Bun...");
const projectRoot = import.meta.dir;

Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;
    console.log(`[${req.method}] ${pathname}`);

    if (pathname.startsWith('/api/')) {
      if (req.method === 'GET' && pathname.startsWith('/api/gene/')) {
        const geneName = pathname.split('/').pop();
        if (!geneName) return new Response(JSON.stringify({ error: "Gene name is required." }), { status: 400 });
        try {
          const gffData = await getGffData(geneName);
          return new Response(JSON.stringify(gffData), { headers: { 'Content-Type': 'application/json' } });
        } catch (error: any) {
          return new Response(JSON.stringify({ error: error.message }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
      }

      if (req.method === 'POST' && pathname === '/api/score-asos') {
        try {
            const body = await req.json();
            const validation = ScoreAsosBodySchema.safeParse(body);
            if (!validation.success) return new Response(JSON.stringify({ error: "Invalid request body", details: validation.error.flatten() }), { status: 400 });
            const runpodJob = await submitRunpodJob(validation.data);
            return new Response(JSON.stringify({ jobId: runpodJob.id }), { headers: { 'Content-Type': 'application/json' } });
        } catch (error: any) {
          console.error("Error submitting RunPod job:", error);
          return new Response(JSON.stringify({ error: error.message || "Failed to submit job" }), { status: 500 });
        }
      }

      if (req.method === 'GET' && pathname.startsWith('/api/job-status/')) {
          const jobId = pathname.split('/').pop();
          if (!jobId) return new Response(JSON.stringify({ error: "Job ID is required." }), { status: 400 });
          try {
              const status = await endpoint.status(jobId);
              if (status.status === 'COMPLETED') {
                  const metadata = jobMetadataStore.get(jobId);
                  if (metadata) {
                      status.output = enrichRunpodOutput(status.output, metadata);
                      jobMetadataStore.delete(jobId); // Clean up the store
                  }
              }
              return new Response(JSON.stringify(status), { headers: { 'Content-Type': 'application/json' } });
          } catch (error: any) {
              console.error(`Error fetching status for job ${jobId}:`, error);
              return new Response(JSON.stringify({ status: 'FAILED', error: error.message }), { status: 500 });
          }
      }

       if (req.method === 'POST' && pathname.startsWith('/api/cancel-job/')) {
          const jobId = pathname.split('/').pop();
          if (!jobId) return new Response(JSON.stringify({ error: "Job ID is required." }), { status: 400 });
          try {
              console.log(`Received request to cancel job: ${jobId}`);
              const result = await endpoint.cancel(jobId);
              jobMetadataStore.delete(jobId); // Also clean up on cancel
              return new Response(JSON.stringify(result));
          } catch (error: any) {
              return new Response(JSON.stringify({ error: error.message }), { status: 500 });
          }
      }
      return new Response(JSON.stringify({ error: "API endpoint not found." }), { status: 404 });
    }

    let filePath = path.join(projectRoot, pathname);
    if (pathname.endsWith('/')) filePath = path.join(filePath, 'index.html');
    const file = Bun.file(filePath);
    if (await file.exists()) return new Response(file);
    const fileWithIndex = Bun.file(path.join(filePath, 'index.html'));
    if (await fileWithIndex.exists()) return new Response(fileWithIndex);
    return new Response("404: Not Found", { status: 404 });
  },
  error(error) {
    console.error("Server Error:", error);
    return new Response("An internal error occurred", { status: 500 });
  }
});

console.log(`Server listening on http://localhost:3000 | Serving static files from: ${projectRoot}`);

// --- Backend Logic Functions ---

async function submitRunpodJob(data: z.infer<typeof ScoreAsosBodySchema>) {
    const { geneName, transcriptId, sugar, backbone, topN } = data;
    const { targetRna, gene, transcript } = await getTranscriptSequence(geneName, transcriptId);
    const { sugarMods, backboneMods, asoLength } = formatChemistryForApi(sugar, backbone);
    
    console.log(`Submitting async job for ${geneName} (${transcriptId})...`);
    const result = await endpoint.run({
        input: { target_rna: targetRna, aso_length: asoLength, sugar_mods: sugarMods, backbone_mods: backboneMods, dosage: 1, transfection_method: "Lipofection", batch_size: 512 }
    }, 3600 * 1000);

    // Store the metadata needed for enrichment later
    jobMetadataStore.set(result.id, { gene, transcript, topN, targetRna });

    return result;
}

function enrichRunpodOutput(output: any, metadata: { gene: GffFeature, transcript: GffFeature, topN?: number, targetRna: string }) {
    if (!output || !output.csv_output) return output;
    
    const { gene, transcript, topN, targetRna } = metadata;
    const scoredAsos = parseRunPodCsv(output.csv_output);
    const enrichedAsos = enrichAsoData(scoredAsos, targetRna, gene, transcript);
    enrichedAsos.sort((a, b) => b.oligoai_score - a.oligoai_score);
    
    output.enriched_results = topN ? enrichedAsos.slice(0, topN) : enrichedAsos;
    return output;
}

// --- ALL OTHER HELPER FUNCTIONS (getGffData, parseGFF3, etc.) ---
// These are unchanged.

async function getGffData(geneName: string): Promise<any> {
  const gffPath = path.join(projectRoot, 'oligoscan', 'gene_sequences', `${geneName}.gff3.gz`);
  const gffFile = Bun.file(gffPath);
  if (!(await gffFile.exists())) throw new Error(`GFF file not found for gene: ${geneName}`);
  const fileBuffer = await gffFile.arrayBuffer();
  const decompressed = Bun.gunzipSync(fileBuffer);
  return parseGFF3(new TextDecoder().decode(decompressed));
}

async function getTranscriptSequence(geneName: string, transcriptId: string) {
    const gffData = await getGffData(geneName);
    const fastaPath = path.join(projectRoot, 'oligoscan', 'gene_sequences', `${geneName}.fa.gz`);
    const fastaFile = Bun.file(fastaPath);
    if (!(await fastaFile.exists())) throw new Error(`FASTA file not found for gene: ${geneName}`);
    const fileBuffer = await fastaFile.arrayBuffer();
    const decompressed = Bun.gunzipSync(fileBuffer);
    const fastaContent = new TextDecoder().decode(decompressed);
    const sequenceLines = fastaContent.split('\n').slice(1);
    const fullSequence = sequenceLines.join('').trim().toUpperCase();
    const gene = gffData.gene;
    const transcript = gffData.transcripts.find((t: any) => t.id === transcriptId);
    if (!gene || !transcript) throw new Error(`Transcript ID ${transcriptId} not found for gene ${geneName}`);
    const startIndex = transcript.start - gene.start;
    const endIndex = transcript.end - gene.start + 1;
    return { targetRna: fullSequence.substring(startIndex, endIndex), gene, transcript };
}

function formatChemistryForApi(sugarString: string, backboneString: string) {
    const sugarModsList: string[] = [];
    const multiplierRegex = /^(\d+)x(.+)$/i;
    for (const part of sugarString.split(',')) {
        const match = part.trim().match(multiplierRegex);
        if (match) {
            const count = parseInt(match[1], 10);
            const chem = match[2].toUpperCase() === 'CET' ? 'cEt' : match[2].toUpperCase();
            for (let i = 0; i < count; i++) sugarModsList.push(chem);
        } else {
            const chem = part.trim().toUpperCase();
            sugarModsList.push(chem === 'CET' ? 'cEt' : chem);
        }
    }
    const backboneModsList = [...backboneString.toUpperCase().split('').map(c => c === 'S' ? 'PS' : 'PD'), '<pad>'];
    return {
        sugarMods: JSON.stringify(sugarModsList),
        backboneMods: JSON.stringify(backboneModsList),
        asoLength: sugarModsList.length,
    };
}

function parseRunPodCsv(csv: string): any[] {
    if (!csv) return [];
    return csv.trim().split('\n').slice(1).map(line => {
        const [position, aso_sequence, oligoai_score] = line.split(',');
        return { position: parseInt(position, 10), aso_sequence, oligoai_score: parseFloat(oligoai_score) };
    });
}

function enrichAsoData(asos: any[], targetRna: string, gene: GffFeature, transcript: GffFeature) {
    const calculateGC = (seq: string) => (seq.match(/[GC]/g) || []).length / seq.length * 100;
    const asoLength = asos[0]?.aso_sequence.length || 20;
    return asos.map(aso => {
        const genomicPosition = gene.start + aso.position;
        return {
            ...aso,
            genomic_coordinate: `${gene.seqid}:${genomicPosition}`,
            target_sequence: targetRna.substring(aso.position, aso.position + asoLength),
            gc_content: calculateGC(aso.aso_sequence),
            region: getAsoRegion(genomicPosition, asoLength, transcript)
        };
    });
}

function getAsoRegion(asoStartPos: number, asoLength: number, transcript: GffFeature): string {
    const asoEndPos = asoStartPos + asoLength - 1;
    const checkOverlap = (feature: any) => Math.max(asoStartPos, feature.start) <= Math.min(asoEndPos, feature.end);
    for (const utr of transcript.utrs ?? []) if (checkOverlap(utr)) return utr.type === 'five_prime_UTR' ? "5'UTR" : "3'UTR";
    for (const cds of transcript.cds ?? []) if (checkOverlap(cds)) return "Exonic (CDS)";
    for (const exon of transcript.exons ?? []) if (checkOverlap(exon)) return "Exonic";
    return "Intronic";
}

function parseGFF3(gffContent: string) {
    const lines = gffContent.split('\n');
    const features: GffFeature[] = [];
    let geneInfo: GffFeature | null = null;
    let minCoord = Infinity, maxCoord = -Infinity;

    for (const line of lines) {
        if (line.startsWith('#') || line.trim() === '') continue;
        const columns = line.split('\t');
        if (columns.length !== 9) continue;

        const [seqid, , type, startStr, endStr, , strand, , attributesStr] = columns;
        const start = parseInt(startStr, 10), end = parseInt(endStr, 10);
        if (isNaN(start) || isNaN(end)) continue;

        minCoord = Math.min(minCoord, start);
        maxCoord = Math.max(maxCoord, end);

        const attributes = Object.fromEntries(attributesStr.split(';').map(attr => attr.split('=').map(s => s.trim())));
        const feature: GffFeature = { seqid, type, start, end, strand, attributes, id: attributes.ID, parentId: attributes.Parent, name: attributes.Name };
        features.push(feature);
        if (type === 'gene' && !geneInfo) geneInfo = feature;
    }

    const transcriptMap = new Map<string, GffFeature>();
    features.forEach(f => {
        if (['mRNA', 'transcript', 'lnc_RNA'].includes(f.type) && f.id) {
            const tags = f.attributes.tag ? f.attributes.tag.split(',') : [];
            transcriptMap.set(f.id, { ...f, isCanonical: tags.includes('Ensembl_canonical') || tags.includes('MANE_Select'), exons: [], cds: [], utrs: [] });
        }
    });

    features.forEach(feature => {
        if (feature.parentId && transcriptMap.has(feature.parentId)) {
            const parent = transcriptMap.get(feature.parentId)!;
            if (feature.type === 'exon') parent.exons.push(feature);
            else if (feature.type === 'CDS') parent.cds.push(feature);
            else if (feature.type.endsWith('_UTR')) parent.utrs.push(feature);
        }
    });

    transcriptMap.forEach(t => {
        t.exons?.sort((a, b) => a.start - b.start);
        t.cds?.sort((a, b) => a.start - b.start);
        t.utrs?.sort((a, b) => a.start - b.start);
    });

    return { gene: geneInfo, transcripts: Array.from(transcriptMap.values()), minCoord: minCoord === Infinity ? 0 : minCoord, maxCoord: maxCoord === -Infinity ? 0 : maxCoord };
}
