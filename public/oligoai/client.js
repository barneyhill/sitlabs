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


        // Load gene visualization
        await loadGeneVisualization(metadata.gene);

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

    if (isNaN(dosage) || dosage <= 0) {
        showError("Dosage must be a positive number.", 'aso');
        setLoadingState(false, 'aso');
        return;
    }

    const requestBody = {
        geneName,
        transcriptId: selectedTranscript.id,
        sugar,
        backbone,
        transfectionMethod,
        dosage
    };

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

        const requestBody = {
            geneName,
            transcriptId: selectedTranscript.id,
            sugar,
            backbone,
            transfectionMethod,
            dosage
        };

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
        document.getElementById('aso-table-subtitle').textContent =
            `${metadata.gene} - ${metadata.transcriptName} (${pagination.total.toLocaleString()} total ASOs)`;

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
    const p = { t: 20, r: 20, b: 50, l: 100 };
    
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
    currentGffData.plotParams = { minCoord, maxCoord, scaleX, svgHeight };

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
}

function showMarkerOnPlot(position) {
    hideMarkerOnPlot();
    const svg = document.getElementById('transcript-plot-svg');
    if (!currentGffData?.plotParams) return;
    const { minCoord, maxCoord, scaleX, svgHeight } = currentGffData.plotParams;
    if (position < minCoord || position > maxCoord) return;
    const x = scaleX(position);
    const marker = document.createElementNS(svgNS, 'line');
    marker.id = 'aso-hover-marker';
    marker.setAttribute('x1', x); marker.setAttribute('y1', 0);
    marker.setAttribute('x2', x); marker.setAttribute('y2', svgHeight);
    marker.setAttribute('stroke', '#E8796A'); marker.setAttribute('stroke-width', '1.5');
    marker.setAttribute('stroke-dasharray', '4 4');
    svg.appendChild(marker);
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
