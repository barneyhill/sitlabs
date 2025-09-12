// sitlabs/oligoscan/client.js

let currentGffData = null;
const svgNS = "http://www.w3.org/2000/svg";

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('search-button').addEventListener('click', handleGeneSearch);
    ['gene-search', 'chemistry-input', 'backbone-input', 'top-n-input'].forEach(id => {
        document.getElementById(id).addEventListener('keypress', e => e.key === 'Enter' && handleGeneSearch());
    });
    document.getElementById('about-link').addEventListener('click', e => { e.preventDefault(); togglePopup(true); });
    document.getElementById('close-popup').addEventListener('click', () => togglePopup(false));
    document.getElementById('popup-overlay').addEventListener('click', () => togglePopup(false));
    handleGeneSearch(); // Initial search on page load
});

async function handleGeneSearch() {
    const geneName = document.getElementById('gene-search').value.trim();
    if (!geneName) return showError('Please enter a gene name.');
    resetUIState();
    setLoadingState(true, 'transcript', `Loading gene data for ${geneName}...`);

    try {
        const response = await fetch(`/api/gene/${geneName}`);
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || `Gene '${geneName}' not found.`);
        }
        currentGffData = await response.json();
        if (!currentGffData || !currentGffData.transcripts || currentGffData.transcripts.length === 0) {
            throw new Error(`No transcripts found for '${geneName}'.`);
        }
        renderTranscripts(currentGffData, document.getElementById('transcript-plot-svg'));
    } catch (error) {
        console.error('Error fetching gene data:', error);
        showError(error.message, 'transcript');
    } finally {
        setLoadingState(false, 'transcript');
    }
}

async function handleTranscriptClick(transcript) {
    const geneName = document.getElementById('gene-search').value.trim();
    const sugar = document.getElementById('chemistry-input').value.trim();
    const backbone = document.getElementById('backbone-input').value.trim();
    const topNRaw = document.getElementById('top-n-input').value.trim();
    
    resetResultsState();
    setLoadingState(true, 'aso', `Scoring ASOs for ${transcript.name || transcript.id}...`);

    try {
        const response = await fetch('/api/score-asos', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ geneName, transcriptId: transcript.id, sugar, backbone, topN: topNRaw ? parseInt(topNRaw, 10) : undefined })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Failed to get ASO scores from server.');
        }
        const asoResults = await response.json();
        if (!asoResults || asoResults.length === 0) {
            throw new Error(`No valid ASOs returned for transcript ${transcript.name || transcript.id}.`);
        }
        const transcriptName = transcript.name || transcript.id.split(':').pop();
        document.getElementById('aso-table-subtitle').textContent = `Top ${asoResults.length} ASOs for ${transcriptName}`;
        displayASOTable(asoResults, geneName, transcriptName);
    } catch (error) {
        console.error('Error scoring ASOs:', error);
        showError(error.message, 'aso');
    } finally {
        setLoadingState(false, 'aso');
    }
}

function displayASOTable(asoSequences, geneName, transcriptName) {
    const container = document.getElementById('results-container');
    container.innerHTML = '';
    const table = document.createElement('table');
    table.innerHTML = `<tr><th>Genomic Coordinate</th><th>Region</th><th>Target Sequence</th><th>ASO Sequence</th><th>GC Content (%)</th><th>OligoScan Score</th></tr>`;
    
    const sugarPattern = document.getElementById('chemistry-input').value;
    const isModified = (index) => {
        // A simplified check to highlight non-DNA wings. This could be made more robust.
        return sugarPattern.toLowerCase().includes('moe') || sugarPattern.toLowerCase().includes('cet');
    };

    asoSequences.forEach(aso => {
        const row = table.insertRow();
        row.dataset.position = aso.genomic_coordinate.split(':')[1];
        
        let styledAso = aso.aso_sequence.split('').map((base, i) => isModified(i) ? `<b>${base}</b>` : base).join('');

        row.innerHTML = `
            <td>${aso.genomic_coordinate}</td>
            <td>${aso.region}</td>
            <td style="font-family: monospace;">${aso.target_sequence}</td>
            <td style="font-family: monospace;">${styledAso}</td>
            <td>${aso.gc_content.toFixed(1)}</td>
            <td>${aso.oligoai_score.toFixed(4)}</td>
        `;
        row.addEventListener('mouseover', () => showMarkerOnPlot(parseInt(row.dataset.position, 10)));
        row.addEventListener('mouseout', hideMarkerOnPlot);
    });

    container.appendChild(table);
    container.style.display = 'block';
    document.getElementById('aso-table-header').classList.remove('hidden');
    setupDownloadLink(asoSequences, `${geneName}_${transcriptName}_ASOs.csv`);
}

function renderTranscripts(gffData, svgElement) {
    svgElement.innerHTML = '';
    document.getElementById('transcript-plot-title').textContent = `Select a ${gffData.gene?.name || 'Gene'} transcript...`;

    const transcripts = gffData.transcripts.sort((a, b) => (b.isCanonical ?? false) - (a.isCanonical ?? false));
    const { minCoord, maxCoord } = gffData;
    const totalRange = maxCoord - minCoord;
    if (totalRange <= 0) return; // Avoid division by zero

    const p = { t: 20, r: 20, b: 50, l: 100 };
    const svgWidth = svgElement.clientWidth || 800;
    const plotWidth = svgWidth - p.l - p.r;
    const trackH = 20, featH = 10, cdsH = 14, trackS = 15;
    const svgHeight = p.t + p.b + (transcripts.length * (trackH + trackS));
    svgElement.setAttribute('height', svgHeight);

    const scaleX = (coord) => p.l + ((coord - minCoord) / totalRange) * plotWidth;
    currentGffData.plotParams = { minCoord, maxCoord, scaleX, svgHeight };
    
    transcripts.forEach((transcript, index) => {
        const g = document.createElementNS(svgNS, 'g');
        g.classList.add('transcript-row');
        const yCenter = p.t + index * (trackH + trackS) + (trackH / 2);
        
        const firstExon = transcript.exons[0];
        const lastExon = transcript.exons[transcript.exons.length - 1];
        g.innerHTML = `
            <text x="${p.l - 10}" y="${yCenter + 4}" font-size="10px" text-anchor="end" ${transcript.isCanonical ? 'font-weight="bold"' : ''}>${transcript.name || transcript.id.split(':').pop()}</text>
            <line x1="${scaleX(firstExon?.start ?? transcript.start)}" y1="${yCenter}" x2="${scaleX(lastExon?.end ?? transcript.end)}" y2="${yCenter}" stroke="#999"></line>
            ${(transcript.utrs || []).map(utr => `<rect x="${scaleX(utr.start)}" y="${yCenter - featH/2}" width="${Math.max(1, scaleX(utr.end) - scaleX(utr.start))}" height="${featH}" fill="#a9a9a9"></rect>`).join('')}
            ${(transcript.cds || []).map(cds => `<rect x="${scaleX(cds.start)}" y="${yCenter - cdsH/2}" width="${Math.max(1, scaleX(cds.end) - scaleX(cds.start))}" height="${cdsH}" fill="#007bff"></rect>`).join('')}
        `;
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

function setupDownloadLink(data, filename) {
    const link = document.getElementById('download-aso-table');
    const newLink = link.cloneNode(true);
    link.parentNode.replaceChild(newLink, link);
    newLink.addEventListener('click', e => {
        e.preventDefault();
        const headers = "genomic_coordinate,region,target_sequence,aso_sequence,gc_content,oligoai_score";
        const csvRows = data.map(r => [r.genomic_coordinate, r.region, r.target_sequence, r.aso_sequence, r.gc_content.toFixed(1), r.oligoai_score.toFixed(4)].join(','));
        const csv = [headers, ...csvRows].join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
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
    Object.assign(marker, { id: 'aso-hover-marker' });
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
    const loadingId = type === 'transcript' ? 'transcript-loading' : 'loading';
    document.getElementById(loadingId).textContent = message;
    document.getElementById(loadingId).style.display = isLoading ? 'block' : 'none';
    if (type === 'transcript') document.getElementById('transcript-plot-container').style.display = 'block';
}
function showError(message, type) {
    const errorId = type === 'transcript' ? 'transcript-error' : 'error-message';
    const errorEl = document.getElementById(errorId);
    errorEl.textContent = message;
    errorEl.style.display = 'block';
}
function resetUIState() {
    document.getElementById('transcript-plot-container').style.display = 'none';
    document.getElementById('transcript-error').style.display = 'none';
    document.getElementById('transcript-plot-svg').innerHTML = '';
    resetResultsState();
}
function resetResultsState() {
    document.getElementById('results-container').style.display = 'none';
    document.getElementById('loading').style.display = 'none';
    document.getElementById('error-message').style.display = 'none';
    document.getElementById('aso-table-header').classList.add('hidden');
}
