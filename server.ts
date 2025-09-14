import { z } from 'zod';
import path from 'path';
import runpodSdk from "runpod-sdk";
import { gunzipSync, gzipSync } from 'bun';

// --- Zod Schemas ---
const ScoreAsosBodySchema = z.object({
  geneName: z.string().min(1),
  transcriptId: z.string().min(1),
  sugar: z.string().min(1),
  backbone: z.string().min(1),
  transfectionMethod: z.string().min(1),
  dosage: z.number().positive(),
});

// --- Type Definitions ---
interface GffFeature {
  seqid: string; type: string; start: number; end: number; strand: string;
  attributes: Record<string, string>; id?: string; parentId?: string; name?: string;
  exons?: GffFeature[]; cds?: GffFeature[]; utrs?: GffFeature[]; isCanonical?: boolean;
}

interface JobMetadata {
  jobId: string;
  gene: string;
  requestedGeneName: string; // For exact cache matching
  transcriptId: string;
  transcriptName: string;
  chemistry: {
    sugar: string;
    backbone: string;
    transfectionMethod: string;
    dosage: number;
  };
  totalResults: number;
  createdAt: string;
  status: 'pending' | 'completed' | 'failed';
}

interface EnrichedAso {
  position: number;
  aso_sequence: string;
  oligoai_score: number;
  genomic_coordinate: string;
  target_sequence: string;
  gc_content: number;
  region: string;
}

// --- RunPod SDK Initialization ---
const RUNPOD_API_KEY = Bun.env.RUNPOD_API_KEY;
if (!RUNPOD_API_KEY) {
    console.error("FATAL: RUNPOD_API_KEY environment variable is not set.");
    process.exit(1);
}
const RUNPOD_ENDPOINT_ID = "uni6qber6ldu7k";
const runpod = runpodSdk(RUNPOD_API_KEY);
const endpoint = runpod.endpoint(RUNPOD_ENDPOINT_ID);

// --- Results Directory ---
const RESULTS_DIR = path.join(import.meta.dir, 'results');
if (!await Bun.file(RESULTS_DIR).exists()) {
    await Bun.write(path.join(RESULTS_DIR, '.gitkeep'), '');
}

// --- Main Server Logic ---
console.log("Starting SITLabs server with Bun...");
const projectRoot = import.meta.dir;

Bun.serve({
  port: 80,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;
    console.log(`[${req.method}] ${pathname}`);

    // Handle oligoai client-side routing
    if (pathname.startsWith('/oligoai/') && !pathname.includes('.')) {
      const segments = pathname.split('/');
      const jobId = segments[2];
      if (jobId && jobId !== 'index.html') {
        // Serve index.html for client-side routing
        const indexFile = Bun.file(path.join(projectRoot, 'oligoai', 'index.html'));
        if (await indexFile.exists()) {
          return new Response(indexFile, {
            headers: { 'Content-Type': 'text/html' }
          });
        }
      }
    }

    if (pathname.startsWith('/api/')) {
      if (req.method === 'GET' && pathname.startsWith('/api/gene/')) {
        const geneName = pathname.split('/').pop();
        if (!geneName) return new Response(JSON.stringify({ error: "Gene name is required." }), { status: 400 });
        try {
          const gffData = await getGffData(geneName);
          return new Response(JSON.stringify(gffData), { headers: { 'Content-Type': 'application/json' } });
        } catch (error: any) {
          return new Response(JSON.stringify({ error: error.message }), { status: 404 });
        }
      }

      if (req.method === 'POST' && pathname === '/api/score-asos') {
        try {
            const body = await req.json();
            const validation = ScoreAsosBodySchema.safeParse(body);
            if (!validation.success) {
                console.error("Validation error:", validation.error);
                return new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 });
            }
            const jobId = await submitRunpodJob(validation.data);
            return new Response(JSON.stringify({ jobId }), { headers: { 'Content-Type': 'application/json' } });
        } catch (error: any) {
          console.error("Error submitting RunPod job:", error);
          return new Response(JSON.stringify({ error: error.message }), { status: 500 });
        }
      }

      if (req.method === 'GET' && pathname.startsWith('/api/results/')) {
        const parts = pathname.split('/');
        const jobId = parts[3];
        if (!jobId) return new Response(JSON.stringify({ error: "Job ID required" }), { status: 400 });

        // Handle metadata request
        if (parts[4] === 'meta') {
          try {
            const metaPath = path.join(RESULTS_DIR, `${jobId}.meta.json`);
            const metaFile = Bun.file(metaPath);
            if (!await metaFile.exists()) {
              return new Response(JSON.stringify({ error: "Results not found" }), { status: 404 });
            }
            return new Response(metaFile, { headers: { 'Content-Type': 'application/json' } });
          } catch (error: any) {
            return new Response(JSON.stringify({ error: error.message }), { status: 500 });
          }
        }
        
        const readAndDecompressResults = async (jobId: string): Promise<EnrichedAso[]> => {
            const resultsPath = path.join(RESULTS_DIR, `${jobId}.json.gz`);
            const resultsFile = Bun.file(resultsPath);
            if (!await resultsFile.exists()) {
                throw new Error("Results file not found");
            }
            const fileBuffer = await resultsFile.arrayBuffer();
            const decompressed = gunzipSync(fileBuffer);
            return JSON.parse(new TextDecoder().decode(decompressed));
        };

        // Handle CSV download
        if (parts[4] === 'download-csv') {
          try {
            const results = await readAndDecompressResults(jobId);
            const metaPath = path.join(RESULTS_DIR, `${jobId}.meta.json`);
            const metadata: JobMetadata = await Bun.file(metaPath).json();

            const csv = [
              'genomic_coordinate,region,target_sequence,aso_sequence,gc_content,oligoai_score',
              ...results.map(r =>
                `${r.genomic_coordinate},${r.region},"${r.target_sequence}","${r.aso_sequence}",${r.gc_content.toFixed(1)},${r.oligoai_score.toFixed(4)}`
              )
            ].join('\n');

            return new Response(csv, {
              headers: {
                'Content-Type': 'text/csv',
                'Content-Disposition': `attachment; filename="${metadata.gene}_${metadata.transcriptName}_ASOs.csv"`
              }
            });
          } catch (error: any) {
            return new Response(JSON.stringify({ error: error.message }), { status: 500 });
          }
        }

        // Handle paginated results
        const page = parseInt(url.searchParams.get('page') || '1');
        const limit = parseInt(url.searchParams.get('limit') || '100');

        try {
            const allResults = await readAndDecompressResults(jobId);
            const totalResults = allResults.length;
            const totalPages = Math.ceil(totalResults / limit);
            const start = (page - 1) * limit;
            const end = start + limit;
            const paginatedResults = allResults.slice(start, end);

            return new Response(JSON.stringify({
                data: paginatedResults,
                pagination: {
                page,
                limit,
                total: totalResults,
                pages: totalPages
                }
            }), { headers: { 'Content-Type': 'application/json' } });
        } catch (error: any) {
            return new Response(JSON.stringify({ error: error.message }), { status: 500 });
        }
      }
      
      if (req.method === 'GET' && pathname.startsWith('/api/job-status/')) {
        const jobId = pathname.split('/').pop();
        if (!jobId) return new Response(JSON.stringify({ error: "Job ID required" }), { status: 400 });
        
        try {
            const metaPath = path.join(RESULTS_DIR, `${jobId}.meta.json`);
            const metaFile = Bun.file(metaPath);

            if (!await metaFile.exists()) {
                return new Response(JSON.stringify({ status: 'PENDING' }), { headers: { 'Content-Type': 'application/json' } });
            }

            const metadata: JobMetadata = await metaFile.json();

            if (metadata.status === 'completed' || metadata.status === 'failed') {
                return new Response(JSON.stringify({ status: metadata.status.toUpperCase() }), {
                    headers: { 'Content-Type': 'application/json' }
                });
            }

            const runpodStatus = await endpoint.status(jobId, 100000);

            if (runpodStatus.status === 'FAILED') {
                metadata.status = 'failed';
                await Bun.write(metaPath, JSON.stringify(metadata, null, 2));
            }
            
            const statusToReport = runpodStatus.status === 'COMPLETED' ? 'IN_PROGRESS' : runpodStatus.status;

            return new Response(JSON.stringify({ status: statusToReport }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (error: any) {
            return new Response(JSON.stringify({ status: 'FAILED', error: error.message }), { status: 500 });
        }
      }

      if (req.method === 'POST' && pathname.startsWith('/api/cancel-job/')) {
        const jobId = pathname.split('/').pop();
        if (!jobId) return new Response(JSON.stringify({ error: "Job ID required" }), { status: 400 });
        try {
          const result = await endpoint.cancel(jobId);
          // Delete any partial results
          const resultsPath = path.join(RESULTS_DIR, `${jobId}.json.gz`);
          const metaPath = path.join(RESULTS_DIR, `${jobId}.meta.json`);
          if (await Bun.file(resultsPath).exists()) await Bun.write(resultsPath, '');
          if (await Bun.file(metaPath).exists()) await Bun.write(metaPath, '');
          return new Response(JSON.stringify(result));
        } catch (error: any) {
          return new Response(JSON.stringify({ error: error.message }), { status: 500 });
        }
      }

      return new Response(JSON.stringify({ error: "API endpoint not found" }), { status: 404 });
    }

    // Static file serving
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

console.log(`Server listening on http://localhost:80`);

// --- Backend Logic Functions ---

async function findCompletedJob(data: z.infer<typeof ScoreAsosBodySchema>): Promise<string | null> {
    console.log("Checking for cached results...");
    const glob = new Bun.Glob('*.meta.json');

    for await (const file of glob.scan(RESULTS_DIR)) {
        try {
            const metadata: JobMetadata = await Bun.file(path.join(RESULTS_DIR, file)).json();

            if (
                metadata.status === 'completed' &&
                metadata.requestedGeneName?.toLowerCase() === data.geneName.toLowerCase() &&
                metadata.transcriptId === data.transcriptId &&
                metadata.chemistry.sugar === data.sugar &&
                metadata.chemistry.backbone === data.backbone &&
                metadata.chemistry.transfectionMethod === data.transfectionMethod &&
                metadata.chemistry.dosage === data.dosage
            ) {
                console.log(`Cache hit: Found existing job ${metadata.jobId}`);
                return metadata.jobId;
            }
        } catch (e) {
            console.error(`Error reading or parsing metadata file ${file}:`, e);
        }
    }

    console.log("Cache miss: No existing completed job found.");
    return null;
}

async function submitRunpodJob(data: z.infer<typeof ScoreAsosBodySchema>) {
    // --- CACHE CHECK ---
    const cachedJobId = await findCompletedJob(data);
    if (cachedJobId) {
        return cachedJobId;
    }
    // --- END CACHE CHECK ---

    const { geneName, transcriptId, sugar, backbone, transfectionMethod, dosage } = data;
    const { targetRna, gene, transcript } = await getTranscriptSequence(geneName, transcriptId);
    const { sugarMods, backboneMods, asoLength } = formatChemistryForApi(sugar, backbone);

    console.log(`Submitting job for ${geneName} (${transcriptId})...`);

    // Submit job
    const result = await endpoint.run({
        input: {
            target_rna: targetRna,
            aso_length: asoLength,
            sugar_mods: sugarMods,
            backbone_mods: backboneMods,
            dosage: dosage,
            transfection_method: transfectionMethod,
            batch_size: 512
        }
    }, 3600 * 1000);

    const jobId = result.id;

    // Save initial metadata
    const metadata: JobMetadata = {
        jobId,
        gene: gene.name || geneName,
        requestedGeneName: geneName,
        transcriptId: transcript.id,
        transcriptName: transcript.name || transcript.id,
        chemistry: { sugar, backbone, transfectionMethod, dosage },
        totalResults: 0,
        createdAt: new Date().toISOString(),
        status: 'pending'
    };

    await Bun.write(
        path.join(RESULTS_DIR, `${jobId}.meta.json`),
        JSON.stringify(metadata, null, 2)
    );

    // Start background processing
    processJobInBackground(jobId, targetRna, gene, transcript, asoLength);

    return jobId;
}

async function processJobInBackground(jobId: string, targetRna: string, gene: GffFeature, transcript: GffFeature, asoLength: number) {
    try {
        console.log(`Background processing started for job ${jobId}`);
        const metaPath = path.join(RESULTS_DIR, `${jobId}.meta.json`);

        // Poll for completion
        let attempts = 0;
        const maxAttempts = 720; // 60 minutes

        while (attempts < maxAttempts) {
            const status = await endpoint.status(jobId, 100000);

            if (status.status === 'COMPLETED') {
                console.log(`Job ${jobId} completed on RunPod, processing results locally...`);

                const output = status.output;
                const positions: number[] = output.positions || [];
                const scores: number[] = output.scores || [];

                if (positions.length === 0 || scores.length === 0) {
                    throw new Error('No valid results returned from RunPod');
                }

                const enrichedResults = reconstructAndEnrichAsos(positions, scores, targetRna, gene, transcript, asoLength);
                enrichedResults.sort((a, b) => b.oligoai_score - a.oligoai_score);

                const jsonData = JSON.stringify(enrichedResults);
                const compressedData = gzipSync(Buffer.from(jsonData));
                await Bun.write(path.join(RESULTS_DIR, `${jobId}.json.gz`), compressedData);

                // This is the final step. Only after this write is the job truly 'completed'.
                const metadata: JobMetadata = await Bun.file(metaPath).json();
                metadata.status = 'completed';
                metadata.totalResults = enrichedResults.length;
                await Bun.write(metaPath, JSON.stringify(metadata, null, 2));

                console.log(`Job ${jobId} results saved and status updated to completed.`);
                return; // Exit the function successfully
            } else if (status.status === 'FAILED') {
                throw new Error(status.error || 'Job failed on RunPod');
            }

            await new Promise(resolve => setTimeout(resolve, 5000));
            attempts++;
        }

        throw new Error('Job timed out');
    } catch (error: any) {
        console.error(`Error processing job ${jobId}:`, error);
        
        const metaPath = path.join(RESULTS_DIR, `${jobId}.meta.json`);
        if (await Bun.file(metaPath).exists()) {
            const metadata: JobMetadata = await Bun.file(metaPath).json();
            metadata.status = 'failed';
            await Bun.write(metaPath, JSON.stringify(metadata, null, 2));
        }
    }
}

function reverseComplement(rna: string): string {
    const complement: Record<string, string> = {'A': 'T', 'U': 'A', 'G': 'C', 'C': 'G'};
    return rna.split('').reverse().map(base => complement[base] || base).join('');
}

function reconstructAndEnrichAsos(
    positions: number[],
    scores: number[],
    targetRna: string,
    gene: GffFeature,
    transcript: GffFeature,
    asoLength: number
): EnrichedAso[] {
    const calculateGC = (seq: string) => (seq.match(/[GC]/g) || []).length / seq.length * 100;

    return positions.map((pos, i) => {
        const targetSequence = targetRna.substring(pos, pos + asoLength);
        const asoSequence = reverseComplement(targetSequence.replace(/T/g, 'U'));
        const genomicPosition = gene.start + pos;

        return {
            position: pos,
            aso_sequence: asoSequence,
            oligoai_score: scores[i],
            genomic_coordinate: `${gene.seqid}:${genomicPosition}`,
            target_sequence: targetSequence,
            gc_content: calculateGC(asoSequence),
            region: getAsoRegion(genomicPosition, asoLength, transcript)
        };
    });
}

// All other helper functions remain the same
async function getGffData(geneName: string): Promise<any> {
  const gffPath = path.join(projectRoot, 'oligoai', 'gene_sequences', `${geneName}.gff3.gz`);
  const gffFile = Bun.file(gffPath);
  if (!(await gffFile.exists())) throw new Error(`GFF file not found for gene: ${geneName}`);
  const fileBuffer = await gffFile.arrayBuffer();
  const decompressed = Bun.gunzipSync(fileBuffer);
  return parseGFF3(new TextDecoder().decode(decompressed));
}

async function getTranscriptSequence(geneName: string, transcriptId: string) {
    const gffData = await getGffData(geneName);
    const fastaPath = path.join(projectRoot, 'oligoai', 'gene_sequences', `${geneName}.fa.gz`);
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
