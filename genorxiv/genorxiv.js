class GenomeBrowser {
    constructor() {
        this.state = {
            viewport: {
                isDragging: false,
                dragStart: null,
                lastPosition: null,
            },
            data: {
                startPos: null,
                endPos: null,
                currentGenes: null,
                markers: [],
                currentChromosome: null
            },
            ui: {
                geneLabels: [],
                markerPins: [],
                app: null,
                geneContainer: null,
                markerContainer: null,
                ruler: null
            }
        };
    }

    initPixiApp() {
        const container = document.getElementById('gene-container');
        const isMobile = /Android|iPhone|iPad|iPod|BlackBerry|IEMobile/i.test(navigator.userAgent);
        
        // Changed background color to match dark theme
        this.state.ui.app = new PIXI.Application({
            resizeTo: container,
            backgroundColor: 0x1a1a1a, // Changed to dark background
            resolution: window.devicePixelRatio || 1,
            antialias: !isMobile,
            autoDensity: true,
        });

        container.appendChild(this.state.ui.app.view);
        
        this.state.ui.geneContainer = new PIXI.Container();
        this.state.ui.ruler = new PIXI.Container();
        this.state.ui.markerContainer = new PIXI.Container();
        
        this.state.ui.ruler.y = 60;
        
        // Change the order: Add ruler first, then genes and markers
        this.state.ui.app.stage.addChild(this.state.ui.ruler);
        this.state.ui.app.stage.addChild(this.state.ui.geneContainer);
        this.state.ui.app.stage.addChild(this.state.ui.markerContainer);
    
        this.setupEventListeners();
    }

    // Load findings from JSONL file
    // Inside loadFindings method, add these console logs:
    async loadFindings() {
        try {
            console.log('Starting to load findings...');
            const response = await fetch('./parsed_findings_w_chrpos.jsonl');
            console.log('Fetched response:', response.status);
            const text = await response.text();
            console.log('Current chromosome:', this.state.data.currentChromosome);
            
            // First, parse all markers
            const allMarkers = text.trim().split('\n')
                .map(line => {
                    try {
                        console.log('Parsing line:', line);
                        const finding = JSON.parse(line);
                        let chromosome, position;
                        
                        if (finding.chrpos) {
                            [chromosome, position] = finding.chrpos.split(':');
                            console.log('Found chrpos:', chromosome, position);
                        } 
                        else {
                            console.log('No position found in:', finding);
                            return null;
                        }
                        
                        return {
                            position: parseInt(position),
                            chromosome: chromosome,
                            rsid: finding.loci,
                            finding: finding.finding,
                            positive: finding.positive_original_finding,
                            link: finding.link,
                            title: finding.title
                        };
                    } catch (e) {
                        console.error('Failed to parse line:', line, e);
                        return null;
                    }
                })
                .filter(marker => {
                    if (!marker) {
                        console.log('Filtered out null marker');
                        return false;
                    }
                    if (isNaN(marker.position)) {
                        console.log('Filtered out NaN position:', marker);
                        return false;
                    }
                    if (marker.chromosome !== this.state.data.currentChromosome) {
                        console.log('Filtered out wrong chromosome:', marker.chromosome, 'looking for:', this.state.data.currentChromosome);
                        return false;
                    }
                    return true;
                });
    
            // Group markers by rsid and keep only one marker per locus (the first one)
            const uniqueMarkers = Object.values(
                allMarkers.reduce((acc, marker) => {
                    if (!acc[marker.rsid]) {
                        acc[marker.rsid] = marker;
                    }
                    return acc;
                }, {})
            );
    
            // Store all markers for the panel display, but only plot unique markers
            this.state.data.allMarkers = allMarkers;  // Store all markers for panel display
            this.state.data.markers = uniqueMarkers;  // Store only unique markers for plotting
                    
            console.log('Final unique markers:', uniqueMarkers);
                    
        } catch (error) {
            console.error('Failed to load findings:', error);
            this.state.data.markers = [];
            this.state.data.allMarkers = [];
        }
    }

    createMarkerPin(marker, start, end) {
        const container = new PIXI.Container();
        const group = new PIXI.Container();
        container.addChild(group);
    
        // Create star shape using Graphics
        const star = new PIXI.Graphics();
        star.lineStyle(4, 0xFFFFFF);  // White lines, thickness of 4
        
        // Draw 3 intersecting lines
        const radius = 10;
        
        // Vertical line
        star.moveTo(0, -radius);
        star.lineTo(0, radius);
        
        // Line at 60 degrees
        star.moveTo(radius * Math.cos(Math.PI/6), -radius * Math.sin(Math.PI/6));
        star.lineTo(-radius * Math.cos(Math.PI/6), radius * Math.sin(Math.PI/6));
        
        // Line at -60 degrees
        star.moveTo(-radius * Math.cos(Math.PI/6), -radius * Math.sin(Math.PI/6));
        star.lineTo(radius * Math.cos(Math.PI/6), radius * Math.sin(Math.PI/6));
    
        // Add invisible hit area
        star.hitArea = new PIXI.Circle(0, 0, radius);
    
        star.pivot.set(0, 0);
        group.addChild(star);
    
        group.scale.set(1 / this.state.ui.geneContainer.scale.x);
    
        const x = ((marker.position - start) * this.state.ui.app.screen.width) / (end - start);
        container.x = x;
        container.y = 30;
    
        star.eventMode = 'static';
        star.cursor = 'pointer';
        star.interactive = true;  // Add this new line
        
        // Store the pin in the array (keep this line)
        this.state.ui.markerPins.push(group);
        
        // Replace the old event handlers with the new ones
        star.on('pointerover', () => {
            if (!star.selected) {
                star.scale.set(1.25);
            }
        });
        
        star.on('pointerout', () => {
            if (!star.selected) {
                star.scale.set(1);
            }
        });
        
        star.on('pointerdown', (event) => {
            event.stopPropagation();
            
            // Reset all stars
            this.state.ui.markerPins.forEach(pin => {
                const otherStar = pin.children[0];
                otherStar.selected = false;
                otherStar.scale.set(1);
                otherStar.tint = 0x808080; // Set to light grey
            });
            
            // Make selected star larger and white
            star.selected = true;
            star.scale.set(1.5);
            star.tint = 0xFFFFFF; // Reset to white
            container.parent.addChild(container);
                    
            const markerList = document.querySelector('.marker-list');
            markerList.innerHTML = '';        
    
            // First, create "Selected Locus" section
            const selectedSection = document.createElement('div');
            selectedSection.className = 'marker-section';
            const selectedHeader = document.createElement('h3');
            selectedHeader.textContent = 'Selected Locus';
            selectedSection.appendChild(selectedHeader);
    
            // Create marker group for selected locus
            const selectedMarkers = this.state.data.allMarkers
                .filter(m => m.rsid === marker.rsid);
    
            const selectedGroup = document.createElement('div');
            selectedGroup.className = 'marker-group selected';
    
            // Add locus header
            const headerDiv = document.createElement('div');
            headerDiv.className = 'marker-header';
            headerDiv.textContent = `${marker.rsid}`;
            selectedGroup.appendChild(headerDiv);
    
            // Add findings for selected locus
            selectedMarkers.forEach(m => {
                const findingDiv = document.createElement('div');
                findingDiv.className = 'marker-content';
                
                const findingsList = document.createElement('ul');
                findingsList.className = 'marker-findings';
                
                const findingItem = document.createElement('li');
                
                const paperTitle = document.createElement('div');
                paperTitle.className = 'paper-title';
                paperTitle.textContent = m.title;
                paperTitle.onclick = (e) => {
                    e.stopPropagation();
                    window.open(m.link, '_blank');
                };
                
                const findingText = document.createElement('div');
                findingText.className = 'finding-text';
                findingText.textContent = m.finding;
                
                findingItem.appendChild(paperTitle);
                findingItem.appendChild(findingText);
                findingsList.appendChild(findingItem);
                findingDiv.appendChild(findingsList);
                selectedGroup.appendChild(findingDiv);
            });
    
            selectedSection.appendChild(selectedGroup);
            markerList.appendChild(selectedSection);
    
            // Create "Nearby Loci" section
            const nearbySection = document.createElement('div');
            nearbySection.className = 'marker-section';
            const nearbyHeader = document.createElement('h3');
            nearbyHeader.textContent = 'Nearby Loci';
            nearbySection.appendChild(nearbyHeader);
    
            // Get and group nearby markers
            const nearbyMarkers = this.state.data.allMarkers
                .filter(m => m.rsid !== marker.rsid)
                .map(m => ({
                    ...m,
                    distance: Math.abs(m.position - marker.position)
                }))
                .sort((a, b) => a.distance - b.distance)
                .slice(0, 20);
    
            // Create a map of position to pin for quick lookup
            const pinsByPosition = new Map();
            this.state.ui.markerPins.forEach(pin => {
                pinsByPosition.set(pin.parent.x, pin);
            });
    
            // Group nearby markers by rsid
            const groupedMarkers = {};
            nearbyMarkers.forEach(m => {
                if (!groupedMarkers[m.rsid]) {
                    groupedMarkers[m.rsid] = [];
                }
                groupedMarkers[m.rsid].push(m);
            });
    
            // Create HTML for each nearby group
            Object.entries(groupedMarkers).forEach(([rsid, markers]) => {
                const markerGroup = document.createElement('div');
                markerGroup.className = 'marker-group';
            
                const headerDiv = document.createElement('div');
                headerDiv.className = 'marker-header';
                const distance = markers[0].distance.toLocaleString();
                headerDiv.textContent = `${rsid} (${distance}bp away)`;
                markerGroup.appendChild(headerDiv);            
    
                const findingsList = document.createElement('ul');
                findingsList.className = 'marker-findings';
    
                markers.forEach(m => {
                    const findingItem = document.createElement('li');
                    
                    const paperTitle = document.createElement('div');
                    paperTitle.className = 'paper-title';
                    paperTitle.textContent = m.title;
                    paperTitle.onclick = (e) => {
                        e.stopPropagation();
                        window.open(m.link, '_blank');
                    };
                    
                    const findingText = document.createElement('div');
                    findingText.className = 'finding-text';
                    findingText.textContent = m.finding;
                    
                    findingItem.appendChild(paperTitle);
                    findingItem.appendChild(findingText);
                    findingsList.appendChild(findingItem);
                });
    
                markerGroup.appendChild(findingsList);
                nearbySection.appendChild(markerGroup);
            });
    
            markerList.appendChild(nearbySection);
            document.querySelector('.article-panel').classList.add('visible');
        });
        
        return container;
    }

    async parseSearchInput(input) {
        if (input.includes(':')) {
            const [chrom, pos] = input.split(':');
            return { 
                chrom: chrom.startsWith('chr') ? chrom : `chr${chrom}`,
                pos: parseInt(pos)
            };
        }
        
        const response = await fetch(`https://www.barneyhill.com/assets/genova/fh/${input}_mygene_info.json`);
        const geneInfo = await response.json();
        const pos = geneInfo.genomic_pos;
        const midpoint = Math.floor((pos.start + pos.end) / 2);
        return { 
            chrom: pos.chr.startsWith('chr') ? pos.chr : `chr${pos.chr}`,
            pos: midpoint
        };
    }

    async searchPosition() {
        const searchButton = document.getElementById('search-button');
        const searchIcon = document.getElementById('search-icon');
        const loadingIcon = document.getElementById('loading-icon');
        
        searchButton.disabled = true;
        searchIcon.style.display = 'none';
        loadingIcon.style.display = 'block';
        
        try {
            // Clear existing markers
            document.querySelector('.marker-list').innerHTML = '';
            
            const input = document.getElementById('position').value;
            if (!input) return;

            // First get all the data we need
            const { chrom, pos } = await this.parseSearchInput(input);
            
            const data = await fetch(`https://www.barneyhill.com/assets/genova/genes/gencode.v47.annotation.${chrom}.genes.json`)
                .then(response => response.json());

            const features = data.map(feature => ({
                ...feature,
                start: parseInt(feature.start),
                end: parseInt(feature.end)
            }))
            .sort((a, b) => a.start - b.end);
            
            // Only after we have the data, update the state and view
            this.state.data.currentChromosome = chrom;
            this.state.data.startPos = Math.min(...features.map(f => f.start));
            this.state.data.endPos = Math.max(...features.map(f => f.end));
            this.state.data.currentGenes = features;
            
            // Load findings
            await this.loadFindings();
            
            // Now that we have all data, reset the view state
            this.state.ui.geneContainer.removeChildren();
            this.state.ui.markerContainer.removeChildren();
            this.state.ui.geneLabels = [];
            this.state.ui.markerPins = [];
            
            // Reset positions and scales
            this.state.ui.geneContainer.position.x = 0;
            this.state.ui.geneContainer.position.y = 0;
            this.state.ui.geneContainer.scale.x = 1;
            this.state.ui.markerContainer.position.x = 0;
            this.state.ui.markerContainer.position.y = 0;
            this.state.ui.markerContainer.scale.x = 1;
            
            // Finally, display everything
            this.displayGenes(features, this.state.data.startPos, this.state.data.endPos, pos);
            
            await new Promise(resolve => this.state.ui.app.ticker.addOnce(resolve));

            if (this.state.data.markers) {
                const defaultMarker = this.state.data.markers.find(m => m.rsid === 'rs3765467');
                if (defaultMarker) {
                    // Find the corresponding marker pin
                    const markerX = ((defaultMarker.position - this.state.data.startPos) * this.state.ui.app.screen.width) 
                        / (this.state.data.endPos - this.state.data.startPos);
                    
                    const markerPin = this.state.ui.markerContainer.children.find(pin => 
                        Math.abs(pin.x - markerX) < 1
                    );
                    
                    if (markerPin) {
                        const star = markerPin.children[0].children[0];
                        star.emit('pointerdown', new PIXI.FederatedEvent(star));
                    }
                
                }
            }        

        } catch (error) {
            console.error('Search failed:', error);
            alert('Invalid input or gene not found');
        } finally {
            searchButton.disabled = false;
            searchIcon.style.display = 'block';
            loadingIcon.style.display = 'none';
        }
    }

    handleZoom(zoomFactor, centerX) {
        const worldPos = (centerX - this.state.ui.geneContainer.position.x) / this.state.ui.geneContainer.scale.x;
        
        // Apply zoom to both containers
        [this.state.ui.geneContainer, this.state.ui.markerContainer].forEach(container => {
            container.scale.x *= zoomFactor;
            container.position.x = centerX - worldPos * container.scale.x;
        });
        
        this.updateTextScales();
        this.updateRuler();
    }
    
    setupEventListeners() {
        const view = this.state.ui.app.view;
        
        this.onDragStart = this.onDragStart.bind(this);
        this.onDragMove = this.onDragMove.bind(this);
        this.onDragEnd = this.onDragEnd.bind(this);
        this.onWheel = this.onWheel.bind(this);

        view.addEventListener('mousedown', this.onDragStart);
        view.addEventListener('mousemove', this.onDragMove);
        view.addEventListener('mouseup', this.onDragEnd);
        view.addEventListener('touchstart', this.onDragStart);
        view.addEventListener('touchmove', this.onDragMove);
        view.addEventListener('touchend', this.onDragEnd);
        view.addEventListener('wheel', this.onWheel);

        view.addEventListener('gesturestart', e => e.preventDefault());

        view.addEventListener('gesturechange', e => {
            e.preventDefault();
            const dampening = 0.2;
            const centerX = e.clientX - view.getBoundingClientRect().left;
            this.handleZoom(Math.pow(e.scale, dampening), centerX);
        });
    

        const resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                this.state.ui.app.renderer.resize(width, height);
                this.updateRuler();
            }
        });

        resizeObserver.observe(document.getElementById('gene-container'));
    }

    onDragStart(event) {
        this.state.viewport.isDragging = true;
        const point = event.touches ? event.touches[0] : event;
        this.state.viewport.dragStart = { x: point.clientX, y: point.clientY };
        this.state.viewport.lastPosition = { 
            x: this.state.ui.geneContainer.position.x,
            y: this.state.ui.geneContainer.position.y 
        };
    }

    onDragEnd() {
        this.state.viewport.isDragging = false;
    }

    onDragMove(event) {
        if (!this.state.viewport.isDragging) return;
        
        const point = event.touches ? event.touches[0] : event;
        const dx = point.clientX - this.state.viewport.dragStart.x;
        
        this.state.ui.geneContainer.position.x += dx;
        this.state.ui.markerContainer.position.x += dx; // Move markers too
        
        this.state.viewport.dragStart.x = point.clientX;
        this.updateRuler();
    }

    // Update the onWheel method to zoom markers with genes
    onWheel(event) {
        event.preventDefault();
        const centerX = event.clientX - this.state.ui.app.view.getBoundingClientRect().left;
        const zoomFactor = event.deltaY > 0 ? 1.1 : 0.9;
        this.handleZoom(zoomFactor, centerX);
    }

    updateTextScales() {
        const ZOOM_THRESHOLD = 10;
        const FADE_RANGE = 20;
        
        // Scale everything inversely with zoom
        [...this.state.ui.geneLabels, ...this.state.ui.markerPins].forEach(element => {
            element.scale.x = 1 / this.state.ui.geneContainer.scale.x;
        });
    
        // Only fade the gene labels
        this.state.ui.geneLabels.forEach(label => {
            const fadeAmount = Math.min(1, Math.max(0, (this.state.ui.geneContainer.scale.x - ZOOM_THRESHOLD) / FADE_RANGE));
            label.alpha = fadeAmount;
        });
    }

    assignRows(genes, minDistance = 100000) {
        if (genes.length === 0) return [];
        
        let rows = [[genes[0]]];
        genes[0].row = 0;
        
        for (let i = 1; i < genes.length; i++) {
            let currentGene = genes[i];
            let placed = false;
            
            for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
                let canFit = true;
                for (let gene of rows[rowIndex]) {
                    const distance = Math.max(currentGene.start, gene.start) - Math.min(currentGene.end, gene.end);
                    if (distance < minDistance) {
                        canFit = false;
                        break;
                    }
                }
                if (canFit) {
                    rows[rowIndex].push(currentGene);
                    currentGene.row = rowIndex;
                    placed = true;
                    break;
                }
            }
            
            if (!placed) {
                rows.push([currentGene]);
                currentGene.row = rows.length - 1;
            }
        }
        
        return Math.max(...genes.map(g => g.row)) + 1;
    }

    getGeneColor(geneName) {
        const hash = [...geneName].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
        const hue = hash % 360;
        return `hsl(${hue}, 70%, 60%)`; 
    }

    createGeneGraphics(gene, x, y, width, exonHeight, geneHeight, exons) {
        const geneDisplay = new PIXI.Container();
        const color = PIXI.utils.string2hex(this.getGeneColor(gene.gene_name));
        
        const visibleElements = new PIXI.Container();
        
        const geneRect = new PIXI.Graphics();
        geneRect.beginFill(color)
            .drawRect(0, (exonHeight - geneHeight) / 2, width, geneHeight);
        visibleElements.addChild(geneRect);
        
        exons.filter(exon => exon.gene_name === gene.gene_name)
            .forEach(exon => {
                const exonX = ((exon.start - gene.start) * width) / (gene.end - gene.start);
                const exonWidth = ((exon.end - exon.start) * width) / (gene.end - gene.start);
                
                const exonRect = new PIXI.Graphics();
                exonRect.beginFill(color)
                    .drawRect(exonX, 0, exonWidth, exonHeight);
                visibleElements.addChild(exonRect);
            });

        geneDisplay.addChild(visibleElements);
            
        const text = new PIXI.Text(gene.gene_name, {
            fontFamily: 'Arial',
            fontSize: 15,
            fill: 0xFFFFFF // Changed to white text
        });
        text.y = -20;
        geneDisplay.addChild(text);
        this.state.ui.geneLabels.push(text);
        
        return geneDisplay;
    }
    
    displayGenes(genes, start, end, targetPos) {
        // Clear existing elements
        this.state.ui.geneContainer.removeChildren();
        this.state.ui.markerContainer.removeChildren();
        this.state.ui.geneLabels = [];
        this.state.ui.markerPins = [];

        // Add markers first, before genes
        if (this.state.data.markers && this.state.data.markers.length > 0) {
            console.log('Adding markers:', this.state.data.markers.length);
            this.state.data.markers.forEach(marker => {
                const markerDisplay = this.createMarkerPin(marker, start, end);
                if (markerDisplay) {
                    this.state.ui.markerContainer.addChild(markerDisplay);
                }
            });
        }
        
        // Filter and process genes and exons
        const exons = genes.filter(item => item.type === 'exon');
        const geneItems = genes.filter(item => item.type === 'gene');
        
        // Define display parameters
        const rowHeight = 65;
        const geneHeight = 4;
        const exonHeight = 40;
        
        // Assign rows to prevent gene overlap
        const numRows = this.assignRows(geneItems);
        
        // Create and position gene displays
        geneItems.forEach(gene => {
            // Calculate gene position and dimensions
            const x = ((gene.start - start) * this.state.ui.app.screen.width) / (end - start);
            const width = ((gene.end - gene.start) * this.state.ui.app.screen.width) / (end - start);
            const y = gene.row * rowHeight + 160;

            // Create gene graphics with exons
            const geneDisplay = this.createGeneGraphics(gene, x, y, width, exonHeight, geneHeight, exons);
            
            // Position the gene display
            geneDisplay.x = x;
            geneDisplay.y = y;
            
            // Add to gene container
            this.state.ui.geneContainer.addChild(geneDisplay);
        });

        // If a target position is specified (e.g., during search), zoom and center on it
        if (targetPos) {
            const zoomLevel = 1000;
            
            // Apply zoom level to both containers
            this.state.ui.geneContainer.scale.x = zoomLevel;
            this.state.ui.markerContainer.scale.x = zoomLevel;
            
            // Calculate the target pixel position
            const targetPixelPos = ((targetPos - start) / (end - start)) * this.state.ui.app.screen.width;
            
            // Center the view on the target position
            const newPosition = this.state.ui.app.screen.width/2 - (targetPixelPos * zoomLevel);
            
            // Apply position to both containers
            this.state.ui.geneContainer.position.x = newPosition;
            this.state.ui.markerContainer.position.x = newPosition;
            
            // Maintain vertical positions
            this.state.ui.geneContainer.position.y = 0;
            this.state.ui.markerContainer.position.y = 0;
        } else {
            // Reset view if no target position
            this.state.ui.geneContainer.scale.x = 1;
            this.state.ui.markerContainer.scale.x = 1;
            this.state.ui.geneContainer.position.x = 0;
            this.state.ui.markerContainer.position.x = 0;
            this.state.ui.geneContainer.position.y = 0;
            this.state.ui.markerContainer.position.y = 0;
        }

        // Update text scaling and ruler
        this.updateTextScales();
        this.updateRuler();
    }

    updateRuler() {
        this.state.ui.ruler.removeChildren();
        
        const scale = this.state.ui.geneContainer.scale.x;
        const viewStart = Math.floor(this.state.data.startPos - (this.state.ui.geneContainer.position.x / scale / this.state.ui.app.screen.width) * (this.state.data.endPos - this.state.data.startPos));
        const viewEnd = Math.ceil(viewStart + (this.state.data.endPos - this.state.data.startPos) / scale);
        const range = viewEnd - viewStart;
        
        const TICK_DENSITY = 5;
        const orderMagnitude = Math.floor(Math.log10(Math.max(1, range / TICK_DENSITY)));
        const baseInterval = Math.pow(10, orderMagnitude);
        const interval = Math.max(1,
            (range / TICK_DENSITY < baseInterval * 2) ? baseInterval : 
            (range / TICK_DENSITY < baseInterval * 5) ? baseInterval * 2 : 
            baseInterval * 5
        );
        
        const gridLines = new PIXI.Graphics();
        gridLines.lineStyle(1, 0x333333); // Darker grid lines
        this.state.ui.ruler.addChild(gridLines);
        
        const rulerLine = new PIXI.Graphics();
        rulerLine.lineStyle(1, 0x8e8e8e); // Light gray ruler
        rulerLine.moveTo(0, 0).lineTo(this.state.ui.app.screen.width, 0);
        this.state.ui.ruler.addChild(rulerLine);
        
        const firstTick = Math.ceil(viewStart / interval) * interval;
        const pixelsPerBase = this.state.ui.app.screen.width / (viewEnd - viewStart);
        
        for (let pos = firstTick; pos < viewEnd; pos += interval) {
            const offsetFromViewStart = pos - viewStart;
            const x = Math.round(offsetFromViewStart * pixelsPerBase);
            
            gridLines.moveTo(x, 5).lineTo(x, this.state.ui.app.screen.height);
            rulerLine.moveTo(x, 0).lineTo(x, 5);
            
            let label;
            if (interval >= 1e6) {
                label = `${Math.floor(pos/1e6)}Mb`;
            } else if (interval >= 1e3) {
                label = `${Math.floor(pos/1e3)}kb`;
            } else {
                label = `${pos}bp`;
            }
            
            const text = new PIXI.Text(label, { 
                fontSize: 10, 
                fill: 0x8e8e8e // Light gray text
            });
            text.x = x - text.width / 2;
            text.y = 6;
            this.state.ui.ruler.addChild(text);
        }
    }

    toggleAbout() {
        const modal = document.querySelector('.about-modal');
        modal.classList.toggle('visible');
    }
}

let browser;

function initializeGenomeBrowser() {
    browser = new GenomeBrowser();
    browser.initPixiApp();
    
    document.getElementById('position').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') browser.searchPosition();
    });
    
    browser.searchPosition();
}

document.addEventListener('DOMContentLoaded', initializeGenomeBrowser);