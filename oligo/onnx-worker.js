// onnx-worker.js

// Import the ONNX Runtime script (adjust path if needed, assuming same directory)
self.importScripts('https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.min.js');
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';


self.onmessage = async (event) => {
    const { seqData, sugarData, backboneData, batchSize, seqLength, modelPath } = event.data;

    // Data received are already BigInt64Array because the buffers were transferred

    try {
        // console.log('[Worker] Creating ONNX session...');
        const session = await ort.InferenceSession.create(modelPath, {
            executionProviders: ['wasm'],
            // Consider disabling session cache if memory issues persist even with workers
            // sessionOptions: { enableMemPattern: false, enableCpuMemArena: false } 
        });

        // console.log(`[Worker] Creating tensors with dimensions: [${batchSize}, ${seqLength}]`);
        const dims = [batchSize, seqLength];
        const seqTensor = new ort.Tensor('int64', seqData, dims);
        const sugarTensor = new ort.Tensor('int64', sugarData, dims);
        const backboneTensor = new ort.Tensor('int64', backboneData, dims);

        const feeds = {
            'seq_input': seqTensor,
            'sugar_input': sugarTensor,
            'backbone_input': backboneTensor
        };

        // console.log('[Worker] Running ONNX inference...');
        const results = await session.run(feeds);
        // console.log('[Worker] Inference complete.');

        const outputTensor = results.score;
        if (!outputTensor) {
            throw new Error("Output tensor named 'score' not found in ONNX model results.");
        }

        // Convert Float32Array to standard Array<number> to send back
        const scores = Array.from(outputTensor.data);
        // console.log("[Worker] Sending scores back:", scores);
        self.postMessage({ success: true, scores: scores });

    } catch (e) {
        console.error(`[Worker] Error during ONNX prediction:`, e);
        self.postMessage({ success: false, error: `ONNX prediction failed in worker: ${e.message || 'Unknown error'}` });
    } finally {
        // Optional: Explicitly release session? May not be necessary as worker terminates.
        // if (session) { /* await session.release(); ? */ } // Check ORT docs if needed

        // Close the worker implicitly by finishing execution after postMessage
        // or explicitly with self.close(); if you want to be sure right away.
        // Since we terminate from the main thread, this isn't strictly needed.
    }
};

// Handle potential errors during worker script loading/initialization itself
self.onerror = (error) => {
    console.error("[Worker] Uncaught error in worker:", error);
    self.postMessage({ success: false, error: "An uncaught error occurred in the worker." });
}; 