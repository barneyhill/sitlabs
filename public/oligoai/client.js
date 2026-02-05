let currentGffData = null;
const svgNS = "http://www.w3.org/2000/svg";

// State management
let activeRunpodJobId = null;
let jobPollingInterval = null;
let currentJobId = null;
let currentPage = 1;
let totalPages = 1;
let currentResults = [];
let emailModalShown = false;
let customFastaData = null; // Store custom FASTA data

document.addEventListener('DOMContentLoaded', async () => {
    setupEventListeners();

    // Check for jobId in URL
    const urlJobId = getJobIdFromUrl();
    if (urlJobId) {
        await loadFromJobId(urlJobId);
    } else {
        // Default search
        handleGeneSearch();
    }
});

function setupEventListeners() {
    document.getElementById('search-button').addEventListener('click', handleGeneSearch);
    ['gene-search', 'chemistry-input', 'backbone-input'].forEach(id => {
        document.getElementById(id).addEventListener('keypress', e => e.key === 'Enter' && handleGeneSearch());
    });
    document.getElementById('about-link').addEventListener('click', e => { e.preventDefault(); togglePopup(true); });
    document.getElementById('close-popup').addEventListener('click', () => togglePopup(false));
    document.getElementById('popup-overlay').addEventListener('click', () => togglePopup(false));

    // FASTA upload event listeners
    document.getElementById('fasta-upload-btn').addEventListener('click', () => {
        document.getElementById('fasta-file-input').click();
    });
    document.getElementById('fasta-file-input').addEventListener('change', handleFastaUpload);

    // Email modal event listeners
    document.getElementById('email-modal-overlay').addEventListener('click', () => closeEmailModal());
    document.getElementById('close-email-modal').addEventListener('click', () => closeEmailModal());
    document.getElementById('submit-with-email').addEventListener('click', () => submitWithEmail());
    document.getElementById('submit-without-email').addEventListener('click', () => submitWithoutEmail());
    document.getElementById('user-email-input').addEventListener('keypress', e => {
        if (e.key === 'Enter') submitWithEmail();
    });

    // Pagination controls
    document.getElementById('prev-page').addEventListener('click', () => changePage(currentPage - 1));
    document.getElementById('next-page').addEventListener('click', () => changePage(currentPage + 1));

    // Action buttons
    document.getElementById('download-csv').addEventListener('click', downloadAllCsv);
    document.getElementById('copy-link').addEventListener('click', copyShareableLink);
}

async function handleFastaUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const fastaBtn = document.getElementById('fasta-upload-btn');
    fastaBtn.classList.add('loading');
    fastaBtn.innerHTML = 'Loading... <i class="fa-solid fa-spinner fa-spin"></i>';

    try {
        const content = await file.text();
        const fastaData = parseFastaFile(content, file.name);
        
        if (!fastaData) {
            throw new Error('Invalid FASTA file format');
        }

        // Get ASO length from chemistry input
        const chemistryInput = document.getElementById('chemistry-input').value.trim();
        let asoLength = 20; // default
        if (chemistryInput) {
            const parts = chemistryInput.split(',');
            asoLength = parts.reduce((sum, part) => {
                const match = part.trim().match(/^(\d+)x/);
                return sum + (match ? parseInt(match[1]) : 1);
            }, 0);
        }

        // Check minimum length requirement (sequence must have at least 100 valid positions for ASOs)
        if (fastaData.length - asoLength < 100) {
            throw new Error(`FASTA sequence must be at least ${asoLength + 100} nucleotides long (ASO length: ${asoLength}, minimum targetable positions: 100)`);
        }

        // Store the custom FASTA data
        customFastaData = fastaData;

        document.getElementById('gene-search').value = fastaData.geneName; // REMOVED

        // Create mock GFF data for visualization
        const mockGffData = createMockGffFromFasta(fastaData);
        currentGffData = mockGffData;

        // Reset UI and display the custom sequence
        resetUIState();
        const container = document.getElementById('transcript-plot-container');
        container.style.display = 'block';

        // Render the custom transcript
        requestAnimationFrame(() => {
            renderTranscripts(mockGffData, document.getElementById('transcript-plot-svg'));
        });

        // Update button to show file loaded
        fastaBtn.classList.remove('loading');
        fastaBtn.innerHTML = `<i class="fa-solid fa-check"></i> ${fastaData.geneName}`;
        
        // Reset after 3 seconds
        setTimeout(() => {
            fastaBtn.innerHTML = 'FASTA <i class="fa-solid fa-file-arrow-up"></i>';
        }, 3000);

    } catch (error) {
        showError(`Failed to load FASTA file: ${error.message}`, 'transcript');
        fastaBtn.classList.remove('loading');
        fastaBtn.innerHTML = 'FASTA <i class="fa-solid fa-file-arrow-up"></i>';
    }

    // Reset file input
    event.target.value = '';
}

function parseFastaFile(content, filename) {
    const lines = content.trim().split('\n');

    // Check if first line is a header
    if (!lines[0].startsWith('>')) {
        return null;
    }

    // Extract sequence name from header or use filename
    let sequenceName = lines[0].substring(1).trim();
    if (!sequenceName) {
        sequenceName = filename.replace(/\.(fa|fasta)$/i, '');
    }

    // Clean up the name - take first word/identifier if complex header
    sequenceName = sequenceName.split(/[\s\|]/)[0];

    // Extract sequence (joining all non-header lines)
    const sequence = lines
        .slice(1)
        .filter(line => !line.startsWith('>'))
        .join('')
        .replace(/\s/g, '')
        .toUpperCase();

    // Accept both DNA (ATCGN) and RNA (AUCGN)
    if (!sequence || !/^[ATUCGN]+$/i.test(sequence)) {
        return null;
    }

    return {
        geneName: sequenceName,
        sequence: sequence,  // Keep original format (RNA or DNA)
        length: sequence.length,
        isCustom: true
    };
}

function createMockGffFromFasta(fastaData) {
    // Create a mock GFF structure that treats the entire sequence as one transcript
    const mockTranscript = {
        id: `${fastaData.geneName}_custom`,
        name: fastaData.geneName,
        type: 'transcript',
        start: 1,
        end: fastaData.length,
        strand: '+',
        seqid: 'custom',
        attributes: {
            ID: `${fastaData.geneName}_custom`,
            Name: fastaData.geneName,
            tag: 'custom_sequence'
        },
        isCanonical: true,
        exons: [{
            id: `${fastaData.geneName}_exon1`,
            type: 'exon',
            start: 1,
            end: fastaData.length,
            strand: '+',
            attributes: {}
        }],
        cds: [], // No CDS for custom sequences
        utrs: [] // No UTRs for custom sequences
    };

    return {
        gene: {
            id: fastaData.geneName,
            name: fastaData.geneName,
            type: 'gene',
            start: 1,
            end: fastaData.length,
            strand: '+',
            seqid: 'custom',
            attributes: {
                ID: fastaData.geneName,
                Name: fastaData.geneName
            }
        },
        transcripts: [mockTranscript],
        minCoord: 1,
        maxCoord: fastaData.length,
        customFastaData: fastaData // Store reference to original FASTA data
    };
}

function validateChemistryLength(backbone, chem) {
    if (!backbone || !chem) {
        return { valid: false, message: "Both backbone and chemistry must be specified." };
    }
    
    // Parse chemistry to count actual nucleotides
    // Format: "5xMOE,10xDNA,5xMOE" -> sum the numbers
    const nucleotideCount = chem
        .split(',')
        .map(part => {
            const match = part.match(/^(\d+)x/);
            return match ? parseInt(match[1], 10) : 0;
        })
        .reduce((sum, count) => sum + count, 0);
    
    if (nucleotideCount === 0) {
        return { 
            valid: false, 
            message: "Could not parse chemistry string. Expected format: '5xMOE,10xDNA,5xMOE'"
        };
    }
    
    const expectedBackboneLength = nucleotideCount - 1;
    
    if (backbone.length !== expectedBackboneLength) {
        return { 
            valid: false, 
            message: `Chemistry validation failed: chemistry specifies ${nucleotideCount} nucleotides, which requires ${expectedBackboneLength} backbone linkages. Got ${backbone.length} backbone characters.`
        };
    }
    
    return { valid: true };
}

function getJobIdFromUrl() {
    const match = window.location.pathname.match(/\/oligoai\/([^\/]+)/);
    return match ? match[1] : null;
}

function updateUrl(jobId) {
    if (jobId) {
        history.pushState({}, '', `/oligoai/${jobId}`);
    } else {
        history.pushState({}, '', '/oligoai');
    }
}

async function loadFromJobId(jobId) {
    setLoadingState(true, 'page', 'Loading analysis...');

    try {
        // Fetch metadata
        const metaResponse = await fetch(`/api/results/${jobId}/meta`);
        if (!metaResponse.ok) {
            throw new Error('Analysis not found');
        }

        const metadata = await metaResponse.json();
        currentJobId = jobId;

        // Populate UI with saved parameters
        document.getElementById('gene-search').value = metadata.gene;
        document.getElementById('chemistry-input').value = metadata.chemistry.sugar;
        document.getElementById('backbone-input').value = metadata.chemistry.backbone;
        document.getElementById('transfection-method-input').value = metadata.chemistry.transfectionMethod;
        document.getElementById('dosage-input').value = metadata.chemistry.dosage;

        // Load gene visualization (unless it's a custom sequence)
        if (!metadata.isCustom) {
            await loadGeneVisualization(metadata.gene);
        }

        // Select the transcript
        selectTranscriptById(metadata.transcriptId);

        // Load results if completed
        if (metadata.status === 'completed') {
            await loadResultsPage(jobId, 1);
        } else if (metadata.status === 'pending') {
            // Resume polling
            pollForCompletion(jobId);
        } else {
            showError('Analysis failed. Please try again.', 'aso');
        }
    } catch (error) {
        showError(error.message || 'Failed to load analysis', 'page');
        updateUrl(null);
    } finally {
        setLoadingState(false, 'page');
    }
}

async function loadGeneVisualization(geneName) {
    const response = await fetch(`/api/gene/${geneName}`);
    if (!response.ok) throw new Error(`Gene '${geneName}' not found`);
    currentGffData = await response.json();
    if (!currentGffData?.transcripts?.length) throw new Error(`No transcripts found for '${geneName}'`);

    // Ensure container is visible before rendering
    const container = document.getElementById('transcript-plot-container');
    container.style.display = 'block';

    // Small delay to ensure DOM is ready
    requestAnimationFrame(() => {
        renderTranscripts(currentGffData, document.getElementById('transcript-plot-svg'));
    });
}

function selectTranscriptById(transcriptId) {
    const rows = document.querySelectorAll('.transcript-row');
    rows.forEach(row => {
        if (row.dataset.transcriptId === transcriptId) {
            row.classList.add('selected');
        }
    });
}

async function handleGeneSearch() {
    const geneName = document.getElementById('gene-search').value.trim();
    if (!geneName) return showError('Please enter a gene name.');

    // Clear any custom FASTA data when doing a gene search
    customFastaData = null;

    resetUIState();
    setLoadingState(true, 'transcript', `Loading gene data for ${geneName}...`);

    try {
        await loadGeneVisualization(geneName);
    } catch (error) {
        showError(error.message, 'transcript');
    } finally {
        setLoadingState(false, 'transcript');
    }
}

// Store the selected transcript for later use
let selectedTranscript = null;

async function handleTranscriptClick(transcript) {
    selectedTranscript = transcript;

    // Cancel any previous job
    if (activeRunpodJobId) {
        console.log(`Cancelling previous job: ${activeRunpodJobId}`);
        fetch(`/api/cancel-job/${activeRunpodJobId}`, { method: 'POST' });
    }
    if (jobPollingInterval) {
        clearInterval(jobPollingInterval);
    }

    resetResultsState();
    setLoadingState(true, 'aso', `Preparing job for ${transcript.name || transcript.id}...`);

    const geneName = document.getElementById('gene-search').value.trim();
    const sugar = document.getElementById('chemistry-input').value.trim();
    const backbone = document.getElementById('backbone-input').value.trim();
    const transfectionMethod = document.getElementById('transfection-method-input').value.trim();
    const dosage = parseInt(document.getElementById('dosage-input').value.trim(), 10);
	
    const chemValidation = validateChemistryLength(backbone, sugar);
    if (!chemValidation.valid) {
        showError(chemValidation.message, 'aso');
        setLoadingState(false, 'aso');
	return;
    }

    if (isNaN(dosage) || dosage <= 0) {
        showError("Dosage must be a positive number.", 'aso');
        setLoadingState(false, 'aso');
        return;
    }

    // Check if this is a custom FASTA sequence
    let requestBody;
    if (currentGffData?.customFastaData) {
        // For custom FASTA, send the sequence directly
        requestBody = {
            geneName,
            transcriptId: selectedTranscript.id,
            sugar,
            backbone,
            transfectionMethod,
            dosage,
            customSequence: currentGffData.customFastaData.sequence,
            isCustom: true
        };

        emailModalShown = true;
        showEmailModal();
        return;

    } else {
        // Standard gene/transcript request
        requestBody = {
            geneName,
            transcriptId: selectedTranscript.id,
            sugar,
            backbone,
            transfectionMethod,
            dosage
        };
    }

    try {
        const checkResponse = await fetch('/api/check-cache', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        if (!checkResponse.ok) throw new Error((await checkResponse.json()).error || 'Failed to check cache');

        const { cachedJobId } = await checkResponse.json();

        if (cachedJobId) {
            currentJobId = cachedJobId;
            updateUrl(cachedJobId);
            await loadResultsPage(cachedJobId, 1);
            setLoadingState(false, 'aso');
        } else {
            emailModalShown = true;
            showEmailModal();
        }
    } catch (error) {
        showError(error.message, 'aso');
        setLoadingState(false, 'aso');
    }
}

async function submitJob(userEmail = null) {
    try {
        const geneName = document.getElementById('gene-search').value.trim();
        const sugar = document.getElementById('chemistry-input').value.trim();
        const backbone = document.getElementById('backbone-input').value.trim();
        const transfectionMethod = document.getElementById('transfection-method-input').value.trim();
        const dosage = parseInt(document.getElementById('dosage-input').value.trim(), 10);

	const chemValidation = validateChemistryLength(backbone, sugar);
	if (!chemValidation.valid) {
    	    showError(chemValidation.message, 'aso');
    	    setLoadingState(false, 'aso');
    	    return;
	}
	
        let requestBody = {
            geneName,
            transcriptId: selectedTranscript.id,
            sugar,
            backbone,
            transfectionMethod,
            dosage
        };

        // Add custom sequence if present
        if (currentGffData?.customFastaData) {
            requestBody.customSequence = currentGffData.customFastaData.sequence;
            requestBody.isCustom = true;
        }

        if (userEmail) {
            requestBody.userEmail = userEmail;
        }

        const response = await fetch('/api/score-asos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) throw new Error((await response.json()).error || 'Failed to submit job');

        const { jobId, cached } = await response.json();
        activeRunpodJobId = jobId;
        currentJobId = jobId;

        // Update URL immediately
        updateUrl(jobId);

        console.log(`Job submitted: ${jobId}, cached: ${cached}`);

        if (cached) {
            // Cached result found, load immediately
            console.log("Cached result found, loading immediately.");
            await loadResultsPage(jobId, 1);
            setLoadingState(false, 'aso');
        } else {
            pollForCompletion(jobId);
        }
    } catch (error) {
        showError(error.message, 'aso');
        setLoadingState(false, 'aso');
    }
}

function showEmailModal() {
    document.getElementById('email-modal').classList.remove('hidden');
    document.getElementById('email-modal-overlay').classList.remove('hidden');
    document.getElementById('user-email-input').focus();

    // Update modal content with job details
    const geneName = document.getElementById('gene-search').value.trim();
    const transcriptName = selectedTranscript?.name || selectedTranscript?.id || '';
    document.getElementById('email-modal-gene').textContent = `${geneName} - ${transcriptName}`;
}

function closeEmailModal() {
    document.getElementById('email-modal').classList.add('hidden');
    document.getElementById('email-modal-overlay').classList.add('hidden');
}

async function submitWithEmail() {
    const emailInput = document.getElementById('user-email-input');
    const email = emailInput.value.trim();

    if (!email) {
        emailInput.classList.add('error');
        return;
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        emailInput.classList.add('error');
        return;
    }

    closeEmailModal();
    submitJob(email);
}

function submitWithoutEmail() {
    closeEmailModal();
    submitJob();
}

function pollForCompletion(jobId) {
    let pollCount = 0;
    const maxPolls = 720;

    setLoadingState(true, 'aso', 'Job queued... waiting for worker...');

    jobPollingInterval = setInterval(async () => {
        if (jobId !== activeRunpodJobId && jobId !== currentJobId) {
            clearInterval(jobPollingInterval);
            return;
        }

        if (pollCount++ > maxPolls) {
            showError('Job timed out after 60 minutes.', 'aso');
            clearInterval(jobPollingInterval);
            activeRunpodJobId = null;
            return;
        }

        try {
            const res = await fetch(`/api/job-status/${jobId}`);
            if (!res.ok) throw new Error('Failed to check status');

            const { status } = await res.json();

            if (status === 'IN_PROGRESS') {
                setLoadingState(true, 'aso', 'Worker running... scoring ASOs...');
            } else if (status === 'COMPLETED') {
                clearInterval(jobPollingInterval);
                activeRunpodJobId = null;
                setLoadingState(false, 'aso');

                // Load first page of results
                await loadResultsPage(jobId, 1);
            } else if (status === 'FAILED') {
                clearInterval(jobPollingInterval);
                activeRunpodJobId = null;
                showError('Job failed. Please try again.', 'aso');
            }
        } catch (error) {
            console.error("Polling error:", error);
            showError('Network error while checking job status.', 'aso');
            clearInterval(jobPollingInterval);
            activeRunpodJobId = null;
        }
    }, 5000);
}

async function loadResultsPage(jobId, page) {
    try {
        const response = await fetch(`/api/results/${jobId}?page=${page}&limit=100`);
        if (!response.ok) throw new Error('Failed to load results');

        const { data, pagination } = await response.json();

        currentResults = data;
        currentPage = pagination.page;
        totalPages = pagination.pages;

        // Update subtitle
	const metaResponse = await fetch(`/api/results/${jobId}/meta`);
	const metadata = await metaResponse.json();

	// For custom sequences or when gene/transcript names match, avoid redundancy
	let subtitleText;
	if (metadata.isCustom || metadata.gene === metadata.transcriptName) {
	    subtitleText = `${metadata.gene} (${pagination.total.toLocaleString()} total ASOs)`;
	} else {
	    subtitleText = `${metadata.gene} - ${metadata.transcriptName} (${pagination.total.toLocaleString()} total ASOs)`;
	}
	document.getElementById('aso-table-subtitle').textContent = subtitleText;

        // Display results
        displayASOTable(data);

        // Update pagination controls
        updatePaginationControls(pagination);

        // Show results container
        document.getElementById('results-container').style.display = 'block';
        document.getElementById('aso-table-header').classList.remove('hidden');
    } catch (error) {
        showError('Failed to load results: ' + error.message, 'aso');
    }
}

async function changePage(page) {
    if (page < 1 || page > totalPages || !currentJobId) return;
    await loadResultsPage(currentJobId, page);
}

function updatePaginationControls(pagination) {
    document.getElementById('prev-page').disabled = pagination.page === 1;
    document.getElementById('next-page').disabled = pagination.page === pagination.pages;
    document.getElementById('current-page').textContent = pagination.page;
    document.getElementById('total-pages').textContent = pagination.pages;
}

function displayASOTable(asoSequences) {
    const container = document.getElementById('results-container');
    container.innerHTML = '';
    const table = document.createElement('table');
    table.innerHTML = `<tr><th>Genomic Coordinate</th><th>Region</th><th>ASO Sequence</th><th>GC Content (%)</th><th>OligoAI Score</th></tr>`;

    const sugarPattern = document.getElementById('chemistry-input').value;
    const isModified = (index) => {
        return sugarPattern.toLowerCase().includes('moe') || sugarPattern.toLowerCase().includes('cet');
    };

    asoSequences.forEach(aso => {
        const row = table.insertRow();
        row.dataset.position = aso.genomic_coordinate.split(':')[1];
        let styledAso = aso.aso_sequence.split('').map((base, i) => isModified(i) ? `<b>${base}</b>` : base).join('');
        row.innerHTML = `
            <td>${aso.genomic_coordinate}</td>
            <td>${aso.region}</td>
            <td style="font-family: monospace;">${styledAso}</td>
            <td>${aso.gc_content.toFixed(1)}</td>
            <td>${aso.oligoai_score.toFixed(4)}</td>
        `;
        row.addEventListener('mouseover', () => showMarkerOnPlot(parseInt(row.dataset.position, 10)));
        row.addEventListener('mouseout', hideMarkerOnPlot);
    });

    container.appendChild(table);
}

async function downloadAllCsv() {
    if (!currentJobId) return;
    window.location.href = `/api/results/${currentJobId}/download-csv`;
}

function copyShareableLink() {
    const url = window.location.href;
    const btn = document.getElementById('copy-link');
    const originalHtml = btn.innerHTML;

    const showSuccess = () => {
        btn.innerHTML = '<i class="fa-solid fa-check"></i>';
        btn.style.backgroundColor = '#28a745';
        setTimeout(() => {
            btn.innerHTML = originalHtml;
            btn.style.backgroundColor = '';
        }, 2000);
    };

    // Modern, secure context method
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(url).then(showSuccess).catch(err => {
            console.error('Async copy failed:', err);
        });
    } else {
        // Fallback for insecure contexts (HTTP)
        const textArea = document.createElement('textarea');
        textArea.value = url;
        textArea.style.position = 'absolute';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.select();
        try {
            document.execCommand('copy');
            showSuccess();
        } catch (err) {
            console.error('Fallback copy failed', err);
        }
        document.body.removeChild(textArea);
    }
}

function renderTranscripts(gffData, svgElement) {
    svgElement.innerHTML = '';
    document.getElementById('transcript-plot-title').textContent = `Select a ${gffData.gene?.name || 'Gene'} transcript...`;
    const transcripts = gffData.transcripts.sort((a, b) => (b.isCanonical ?? false) - (a.isCanonical ?? false));
    const { minCoord, maxCoord } = gffData;
    const totalRange = maxCoord - minCoord;
    if (totalRange <= 0) return;
    const p = { t: 20, r: 60, b: 50, l: 100 }; // Increased right padding from 20 to 60

    // Fix: Ensure container is visible and get proper width
    const container = document.getElementById('transcript-plot-container');
    let svgWidth = svgElement.clientWidth || container.clientWidth || 800;

    if (svgWidth === 0) {
        container.style.display = 'block';
        svgElement.style.width = '100%';
        svgWidth = svgElement.getBoundingClientRect().width || 1100 - 50;
    }

    const plotWidth = svgWidth - p.l - p.r;
    const trackH = 20, featH = 10, cdsH = 14, trackS = 15;
    const svgHeight = p.t + p.b + (transcripts.length * (trackH + trackS));
    svgElement.setAttribute('height', svgHeight);
    const scaleX = (coord) => p.l + ((coord - minCoord) / totalRange) * plotWidth;

    transcripts.forEach((transcript, index) => {
        const g = document.createElementNS(svgNS, 'g');
        g.classList.add('transcript-row');
        g.dataset.transcriptId = transcript.id;
        const yCenter = p.t + index * (trackH + trackS) + (trackH / 2);
        const firstExon = transcript.exons[0];
        const lastExon = transcript.exons[transcript.exons.length - 1];

        // Add invisible background rectangle for full-row clicking
        const backgroundRect = document.createElementNS(svgNS, 'rect');
        backgroundRect.setAttribute('x', '0');
        backgroundRect.setAttribute('y', yCenter - trackH/2 - 5);
        backgroundRect.setAttribute('width', svgWidth);
        backgroundRect.setAttribute('height', trackH + 10);
        backgroundRect.setAttribute('fill', 'transparent');
        backgroundRect.classList.add('transcript-row-bg');
        g.appendChild(backgroundRect);

        // Add the visible elements
        const elements = `
            <text x="${p.l - 10}" y="${yCenter + 4}" font-size="10px" text-anchor="end" ${transcript.isCanonical ? 'font-weight="bold"' : ''}>${transcript.name || transcript.id.split(':').pop()}</text>
            <line x1="${scaleX(firstExon?.start ?? transcript.start)}" y1="${yCenter}" x2="${scaleX(lastExon?.end ?? transcript.end)}" y2="${yCenter}" stroke="#999"></line>
            ${(transcript.utrs || []).map(utr => `<rect x="${scaleX(utr.start)}" y="${yCenter - featH/2}" width="${Math.max(1, scaleX(utr.end) - scaleX(utr.start))}" height="${featH}" fill="#a9a9a9"></rect>`).join('')}
            ${(transcript.cds || []).map(cds => `<rect x="${scaleX(cds.start)}" y="${yCenter - cdsH/2}" width="${Math.max(1, scaleX(cds.end) - scaleX(cds.start))}" height="${cdsH}" fill="#007bff"></rect>`).join('')}
        `;
        g.insertAdjacentHTML('beforeend', elements);

        g.addEventListener('click', () => {
            document.querySelectorAll('.transcript-row.selected').forEach(el => el.classList.remove('selected'));
            g.classList.add('selected');
            handleTranscriptClick(transcript);
        });
        g.addEventListener('mouseover', () => !g.classList.contains('selected') && g.classList.add('hover-highlight'));
        g.addEventListener('mouseout', () => g.classList.remove('hover-highlight'));
        svgElement.appendChild(g);
    });

    // --- Draw Axis/Ruler ---
    const axisY = svgHeight - 25; // Position near bottom
    const axisLine = document.createElementNS(svgNS, 'line');
    axisLine.setAttribute('x1', scaleX(minCoord));
    axisLine.setAttribute('y1', axisY);
    axisLine.setAttribute('x2', scaleX(maxCoord));
    axisLine.setAttribute('y2', axisY);
    axisLine.setAttribute('stroke', '#ccc');
    axisLine.setAttribute('stroke-width', '1');
    svgElement.appendChild(axisLine);

    // Add tick marks and labels
    const numTicks = 5; // Adjust as needed
    for (let i = 0; i <= numTicks; i++) {
        const coord = minCoord + (i * (maxCoord - minCoord) / numTicks);
        const x = scaleX(coord);

        // Tick mark
        const tick = document.createElementNS(svgNS, 'line');
        tick.setAttribute('x1', x);
        tick.setAttribute('y1', axisY - 3);
        tick.setAttribute('x2', x);
        tick.setAttribute('y2', axisY + 3);
        tick.setAttribute('stroke', '#ccc');
        svgElement.appendChild(tick);

        // Label
        const label = document.createElementNS(svgNS, 'text');
        label.setAttribute('x', x);
        label.setAttribute('y', axisY + 15);
        label.setAttribute('font-size', '10px');
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('fill', '#666');
        label.textContent = Math.round(coord).toLocaleString();
        svgElement.appendChild(label);
    }

    // Add chromosome label - moved to be inline with ruler
    if (gffData.gene?.seqid) {
        const chrLabel = document.createElementNS(svgNS, 'text');
        chrLabel.setAttribute('x', scaleX(minCoord) - 25);
        chrLabel.setAttribute('y', axisY); // Same Y as the ruler line
        chrLabel.setAttribute('font-size', '11px');
        chrLabel.setAttribute('text-anchor', 'end');
        chrLabel.setAttribute('fill', '#666');
        chrLabel.setAttribute('font-weight', 'bold');
        chrLabel.setAttribute('alignment-baseline', 'middle'); // Vertically center with line
        let chrText = String(gffData.gene.seqid);
        if (!chrText.toLowerCase().startsWith('chr')) {
            chrText = 'chr' + chrText;
        }
        chrLabel.textContent = chrText;
        svgElement.appendChild(chrLabel);
    }

    // Store plot parameters including axisY
    currentGffData.plotParams = { minCoord, maxCoord, scaleX, svgHeight, axisY };
}

function showMarkerOnPlot(position) {
    hideMarkerOnPlot();
    const svg = document.getElementById('transcript-plot-svg');
    if (!currentGffData?.plotParams) return;

    const { minCoord, maxCoord, scaleX, axisY } = currentGffData.plotParams;
    if (position < minCoord || position > maxCoord) return;

    const x = scaleX(position);
    const y = axisY; // Now this will be exactly on the ruler line
    const lineLength = 8;

    // Create asterisk group
    const asteriskGroup = document.createElementNS(svgNS, 'g');
    asteriskGroup.setAttribute('id', 'aso-hover-marker');
    asteriskGroup.setAttribute('pointer-events', 'none');

    // Create the 3 lines for the asterisk
    const angles = [Math.PI / 2, Math.PI / 6, 5 * Math.PI / 6];

    angles.forEach(angle => {
        const line = document.createElementNS(svgNS, 'line');
        line.setAttribute('x1', x - lineLength * Math.cos(angle));
        line.setAttribute('y1', y - lineLength * Math.sin(angle));
        line.setAttribute('x2', x + lineLength * Math.cos(angle));
        line.setAttribute('y2', y + lineLength * Math.sin(angle));
        line.setAttribute('stroke', '#E8796A');
        line.setAttribute('stroke-width', '2');
        asteriskGroup.appendChild(line);
    });

    svg.appendChild(asteriskGroup);
}

function hideMarkerOnPlot() { document.getElementById('aso-hover-marker')?.remove(); }
function togglePopup(show) {
    document.getElementById('about-popup').classList.toggle('hidden', !show);
    document.getElementById('popup-overlay').classList.toggle('hidden', !show);
}
function setLoadingState(isLoading, type, message = '') {
    const loadingId = type === 'transcript' ? 'transcript-loading' : type === 'page' ? 'page-loading' : 'loading';
    const element = document.getElementById(loadingId);
    if (element) {
        element.textContent = message;
        element.style.display = isLoading ? 'block' : 'none';
    }
    if (type === 'transcript') document.getElementById('transcript-plot-container').style.display = 'block';
}
function showError(message, type) {
    const errorId = type === 'transcript' ? 'transcript-error' : 'error-message';
    const errorEl = document.getElementById(errorId);
    errorEl.textContent = message;
    errorEl.style.display = 'block';
    setLoadingState(false, type === 'transcript' ? 'transcript' : 'aso');
}
function resetUIState() {
    document.getElementById('transcript-plot-container').style.display = 'none';
    document.getElementById('transcript-error').style.display = 'none';
    document.getElementById('transcript-plot-svg').innerHTML = '';
    resetResultsState();
    updateUrl(null);
    emailModalShown = false;
}
function resetResultsState() {
    document.getElementById('results-container').style.display = 'none';
    document.getElementById('loading').style.display = 'none';
    document.getElementById('error-message').style.display = 'none';
    document.getElementById('aso-table-header').classList.add('hidden');
    currentResults = [];
    currentPage = 1;
    totalPages = 1;
}
