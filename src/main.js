import './style.css';
import { createWorker } from 'tesseract.js';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import JSZip from 'jszip';
import { 
  Scan, FileUp, Download, CheckCircle, AlertCircle, Trash2, Camera, History, Maximize, RotateCw, createElement
} from 'lucide';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;

// State
let database = [];
let processedDocs = [];
let currentPage = 1;
let dbViewMode = 'today'; // 'today' or 'all'
const pageSize = 5;

try {
  processedDocs = JSON.parse(localStorage.getItem('ocr_queue') || '[]');
} catch (e) { console.error('Queue Load Failed', e); }

let workerPool = [];
const MAX_WORKERS = 4;
let isProcessingQueue = false;

// Selectors
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const cameraInput = document.getElementById('camera-input');
const resultsGrid = document.getElementById('results-grid');
const emptyState = document.getElementById('empty-state');
const queueCountArr = document.getElementById('queue-count');
const totalProcessedArr = document.getElementById('total-processed');
const downloadAllBtn = document.getElementById('download-all');
const clearAllBtn = document.getElementById('clear-all');
const dbBody = document.getElementById('db-body');
const dbPagination = document.getElementById('db-pagination');
const exportCsvBtn = document.getElementById('export-csv');
const dbSearchInput = document.getElementById('db-search');
const dbFilterSelect = document.getElementById('db-filter');
const zoomModal = document.getElementById('zoom-modal');
const zoomImg = document.getElementById('zoom-img');

/**
 * Initialize
 */
async function init() {
  initIcons();
  initWorkers();
  
  // Load Enterprise Database from Local OneDrive Server
  try {
      const res = await fetch('/api/database');
      database = await res.json();
  } catch (e) {
      console.error("Backend offline, falling back to empty DB", e);
      database = [];
  }
  renderDatabase();
  
  if (processedDocs.length > 0) {
      if (emptyState) emptyState.style.display = 'none';
      processedDocs = processedDocs.filter(d => !database.some(r => String(r.queueId) === String(d.id))); // Purge completely saved docs
      processedDocs.forEach(d => {
          renderDocCard(d);
          if (d.status === 'processing' || d.status === 'waiting') {
              d.status = 'waiting'; // Reset hung processes
          }
      });
      syncStorage();
      startQueueProcessing(); // Resume any abandoned PDF scans
  }
  updateStats();
}

function initIcons() {
  const logoEl = document.getElementById('logo-icon');
  if (logoEl) { const i = createElement(Scan); i.setAttribute('width', '32'); i.setAttribute('height', '32'); logoEl.appendChild(i); }
  const upContainer = document.getElementById('upload-icon-container');
  if (upContainer) { const i = createElement(FileUp); i.setAttribute('width', '48'); i.setAttribute('height', '48'); upContainer.appendChild(i); }
  const camEl = document.getElementById('camera-icon');
  if (camEl) { const i = createElement(Camera); i.setAttribute('width', '18'); i.setAttribute('height', '18'); camEl.appendChild(i); }
}

/**
 * Persistence & Stats
 */
function syncStorage() {
    try {
        const unsaved = processedDocs.filter(d => !database.some(r => r.queueId === d.id)).map(d => ({
            ...d, 
            preview: d.persistentPreview || 'IMAGE_DATA_OMITTED' 
        }));
        localStorage.setItem('ocr_queue', JSON.stringify(unsaved));
    } catch (e) {
        console.warn('Storage Quota Full', e);
    }
    updateStats();
}

async function createDocTask(file) {
  const tempUrl = URL.createObjectURL(file);
  const persistentThumb = await generatePersistentThumb(file);

  const doc = { 
    id: Math.random().toString(36).substr(2, 9),
    status: 'waiting', type: 'SCANNING', mainNo: '', secNo: '', history: [],
    preview: tempUrl,
    persistentPreview: persistentThumb,
    file: file,
    rotation: 0
  };
  processedDocs.push(doc);
  renderDocCard(doc);
  syncStorage();
}

async function generatePersistentThumb(file) {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const max = 200;
            const scale = Math.min(max/img.width, max/img.height, 1);
            canvas.width = img.width * scale;
            canvas.height = img.height * scale;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.5));
        };
        img.src = URL.createObjectURL(file);
    });
}

function updateStats() {
  const todayStr = new Date().toLocaleDateString();
  const sysToday = new Date().toISOString().slice(0, 10);
  const todayCount = database.filter(r => {
      if (r.timestamp) return r.timestamp.startsWith(sysToday);
      try { return new Date(r.processDate).toLocaleDateString() === todayStr; } catch(e) { return false; }
  }).length;
  if (totalProcessedArr) totalProcessedArr.textContent = todayCount;
  const pending = processedDocs.filter(d => d.status !== 'done').length;
  if (queueCountArr) queueCountArr.textContent = pending;
}

/**
 * Database
 */
async function saveToDatabase(doc) {
  const duplicate = database.find(r => r.docNo === doc.mainNo && r.category === doc.type && r.docNo !== '' && r.docNo !== 'N/A');
  if (duplicate) {
      showCustomDialog(
          "Access Denied: Duplicate Record",
          `This document (${doc.mainNo}) has already been recorded in the system.\n\nOriginal Entry Date: ${duplicate.processDate}\n\nSystem policy strictly prohibits the storage of duplicate tracking numbers. If modifications are required, please contact the relevant authorized department to amend the original record.`,
          false
      );
      return false;
  }

  showStatus('Transferring to OneDrive...', 'loading');
  try {
      // Extract high-resolution image for backend save
      const fileBase64 = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.readAsDataURL(doc.file);
      });

      const res = await fetch('/api/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ doc: doc, imageBase64: fileBase64 })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Unknown API error");
      
      database = data.db; // Overwrite UI cache with backend truth
      syncStorage();
      renderDatabase();
      
      const banner = document.getElementById('status-banner');
      if (banner) banner.style.display = 'none';
      return true;
  } catch (e) {
      showCustomDialog("Save Failed", "Could not connect to Local OneDrive Server.\n\n" + e.message, false);
      const banner = document.getElementById('status-banner');
      if (banner) banner.style.display = 'none';
      return false;
  }
}

function renderDatabase() {
  if (!dbBody) return;
  const s = (dbSearchInput ? dbSearchInput.value : '').toLowerCase();
  const f = dbFilterSelect ? dbFilterSelect.value : 'all';
  const todayStr = new Date().toLocaleDateString();
  const filtered = database.filter(r => {
      const matchS = String(r.docNo).toLowerCase().includes(s) || String(r.refNo).toLowerCase().includes(s) || String(r.processDate).toLowerCase().includes(s);
      const matchF = f === 'all' || r.category === f;
      
      let matchTab = true;
      if (dbViewMode === 'today') {
          // Compare ISO pure dates (YYYY-MM-DD) natively
          const sysToday = new Date().toISOString().slice(0, 10);
          if (r.timestamp) {
              matchTab = r.timestamp.startsWith(sysToday);
          } else {
              // Legacy fallback
              try { matchTab = new Date(r.processDate).toLocaleDateString() === new Date().toLocaleDateString(); } catch(e) { matchTab = false; }
          }
      }
      return matchS && matchF && matchTab;
  });
  const totalPages = Math.ceil(filtered.length / pageSize);
  if (currentPage > totalPages && totalPages > 0) currentPage = totalPages;
  else if (totalPages === 0) currentPage = 1;
  const start = (currentPage - 1) * pageSize;
  const paginated = filtered.slice(start, start + pageSize);

  if (filtered.length === 0) {
    dbBody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2rem; color: var(--text-muted);">No records found for ${dbViewMode === 'today' ? 'today' : 'this criteria'}.</td></tr>`;
    dbPagination.innerHTML = ''; return;
  }

  dbBody.innerHTML = paginated.map(r => `
    <tr>
      <td style="font-family: monospace; font-weight: 600; color: #e33124;">${r.docNo}</td>
      <td style="font-size: 0.8rem;">${r.refNo}</td>
      <td><span class="badge badge-${r.category.toLowerCase().replace(/ /g, '-')}">${r.category}</span></td>
      <td style="color: var(--text-muted); font-size: 0.8rem;">${r.processDate}</td>
      <td><span class="status-pill status-verified">${r.status}</span></td>
      <td>
        <div style="display: flex; gap: 0.5rem; justify-content: flex-start; align-items: center;">
            <button class="btn-db-action" onclick="showRecordHistory('${r.id}')" title="Audit Trail">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>
            </button>
            <button class="btn-db-action btn-db-delete" onclick="deleteRecord('${r.id}')" title="Delete Record">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
            </button>
        </div>
      </td>
    </tr>
  `).join('');
  renderPagination(totalPages);
}

function renderPagination(totalPages) {
    if (!dbPagination || totalPages <= 1) { dbPagination.innerHTML = ''; return; }
    let btns = `<button class="pagination-btn" onclick="changePage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>Prev</button>`;
    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= currentPage - 1 && i <= currentPage + 1)) {
            btns += `<button class="pagination-btn ${i === currentPage ? 'active' : ''}" onclick="changePage(${i})">${i}</button>`;
        } else if (i === currentPage - 2 || i === currentPage + 2) {
            btns += `<span style="padding:0 5px">...</span>`;
        }
    }
    btns += `<button class="pagination-btn" onclick="changePage(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''}>Next</button>`;
    dbPagination.innerHTML = btns;
}

window.changePage = (p) => { currentPage = p; renderDatabase(); }
window.switchDbTab = (mode) => {
    dbViewMode = mode;
    currentPage = 1;
    document.getElementById('tab-today').classList.toggle('active', mode === 'today');
    document.getElementById('tab-all').classList.toggle('active', mode === 'all');
    renderDatabase();
}
window.deleteRecord = async (id) => { 
    showCustomDialog(
        "Confirm Deletion", 
        "Are you sure you want to permanently delete this record from the Enterprise Database?", 
        true, 
        async () => {
            try {
                const res = await fetch(`/api/delete/${id}`, { method: 'DELETE' });
                const data = await res.json();
                if (data.success) {
                    database = data.db; // Sync perfectly with backend
                    syncStorage(); 
                    renderDatabase();
                } else {
                    showCustomDialog("Error", "Failed to delete record from server.", false);
                }
            } catch (e) {
                showCustomDialog("Error", "Connection to local backend lost.", false);
            }
        }
    );
}
window.showRecordHistory = (id) => {
    const r = database.find(rec => String(rec.id) === String(id));
    if (!r || !r.history || r.history.length === 0) { 
        showCustomDialog("Audit Trail", "No manual corrections recorded for this document. Original OCR data remains unchanged.", false); 
        return; 
    }
    const changes = r.history.map(h => `[${h.date}] ${h.field}: ${h.old} -> ${h.new}`).join('\n\n');
    showCustomDialog("Audit Trail", changes, false);
}

/**
 * Pipeline
 */
async function handleFiles(files) {
  if (!files || files.length === 0) return;
  const fileArray = Array.from(files);
  if (emptyState) emptyState.style.display = 'none';
  showStatus(`Processing ${fileArray.length} items...`, 'loading');
  for (const file of fileArray) {
    try {
        const name = file.name.toLowerCase();
        const type = file.type.toLowerCase();
        if (name.endsWith('.pdf') || type === 'application/pdf') { await processPdf(file); }
        else if (type.startsWith('image/') || name.endsWith('.jpg') || name.endsWith('.jpeg') || name.endsWith('.png') || name.endsWith('.tiff') || name.endsWith('.tif') || name.endsWith('.bmp') || name.endsWith('.webp')) { await createDocTask(file); }
    } catch (e) { console.error('Add fail', e); }
  }
  syncStorage();
  startQueueProcessing();
}

async function processPdf(file) {
  try {
    showStatus(`Opening PDF: ${file.name}...`, 'loading');
    const buf = await file.arrayBuffer();
    const pdfTask = pdfjsLib.getDocument({ data: buf });
    pdfTask.onProgress = (p) => { const pct = Math.round((p.loaded / p.total) * 100); if (!isNaN(pct)) showStatus(`Loading PDF: ${pct}%`, 'loading'); };
    const pdf = await pdfTask.promise;
    
    for (let i = 1; i <= pdf.numPages; i++) {
        showStatus(`Converting Page ${i}/${pdf.numPages}...`, 'loading');
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 1.5 }); // Fast scale
        const canvas = document.createElement('canvas'); canvas.width = vp.width; canvas.height = vp.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.8));
        await createDocTask(new File([blob], `${file.name}_p${i}.jpg`, { type: 'image/jpeg' }));
        
        // Feed it into the processor instantly instead of waiting for the entire heavy PDF to finish
        startQueueProcessing();
    }
  } catch (err) { console.error('PDF Error:', err); alert(`PDF Error: ${err.message}`); }
}

async function startQueueProcessing() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    const runNext = async () => {
        const n = processedDocs.find(d => d.status === 'waiting');
        if (!n) return;
        await processSingleDoc(n);
        await runNext();
    };
    const workers = [];
    for (let i = 0; i < MAX_WORKERS; i++) { workers.push(runNext()); }
    await Promise.all(workers);
    isProcessingQueue = false;
    syncStorage();
    showStatus('Batch Processed.', 'success');
}

async function processSingleDoc(doc) {
    doc.status = 'processing';
    updateDocCard(doc);
    try {
        const source = doc.file ? doc.file : (doc.preview !== 'IMAGE_DATA_OMITTED' ? doc.preview : null);
        if (!source) throw new Error('File lost. Please re-upload.');

        const angles = [0, 90, 180, 270];
        let found = false;

        // Try rotating and scanning until keywords are found
        for (const angle of angles) {
            const currentRotation = (doc.rotation + angle) % 360;
            const wObj = await getAvailableWorker();
            wObj.currentDocId = doc.id; // Map Tesseract worker to this specific UI card
            
            const fill = document.getElementById(`fill-${doc.id}`);
            const lbl = document.querySelector(`#card-${doc.id} .status-label`);
            if (lbl) lbl.textContent = 'Optical Enhancing...';
            if (fill) { fill.style.width = '15%'; fill.style.backgroundColor = 'hsl(18, 100%, 45%)'; } // Slight orange

            const enhancedInput = await getProcessedImage(source, currentRotation);
            
            if (lbl) lbl.textContent = 'Engine Active...';
            if (fill) { fill.style.width = '20%'; fill.style.backgroundColor = 'hsl(24, 100%, 45%)'; } // Mild orange

            const { data: { text } } = await wObj.worker.recognize(enhancedInput);
            
            wObj.currentDocId = null; // Unmap
            wObj.busy = false;

            console.log(`Scanning at ${currentRotation}deg:`, text.substring(0, 100)); // Log snippet

            // Check if this angle worked
            analyzeText(doc, text);
            if (doc.type !== 'SCANNING' && doc.mainNo !== '') {
                doc.rotation = currentRotation; // Lock in the working rotation
                found = true;
                break;
            }
            if (found) break;
        }

        if (!found) {
            const wObj = await getAvailableWorker();
            wObj.currentDocId = doc.id;
            
            const lbl = document.querySelector(`#card-${doc.id} .status-label`);
            if (lbl) lbl.textContent = 'Deep Scan...';
            
            const enhancedInput = await getProcessedImage(source, doc.rotation);
            const { data: { text } } = await wObj.worker.recognize(enhancedInput);
            wObj.currentDocId = null;
            wObj.busy = false;
            analyzeText(doc, text);
            if (doc.type === 'SCANNING') {
                doc.type = 'UNKNOWN FORMAT'; // Final categorical fallback
            }
        }

        doc.status = 'done';
    } catch (e) { 
        doc.status = 'error'; doc.errorMsg = e.message; 
    }
    updateDocCard(doc);
    syncStorage();
}

async function getProcessedImage(source, rotation) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const radian = (rotation % 360) * Math.PI / 180;
            
            // 1. Set Dimensions
            if ((Math.abs(rotation) / 90) % 2 === 1) {
                canvas.width = img.height; canvas.height = img.width;
            } else {
                canvas.width = img.width; canvas.height = img.height;
            }
            
            const ctx = canvas.getContext('2d');
            
            // 2. Hardware-Accelerated Grayscale & Contrast
            ctx.filter = 'grayscale(100%) contrast(150%) brightness(105%)';
            
            // 3. Apply Rotation and Draw
            ctx.translate(canvas.width / 2, canvas.height / 2);
            ctx.rotate(radian);
            ctx.drawImage(img, -img.width / 2, -img.height / 2);

            canvas.toBlob(resolve, 'image/jpeg', 0.8); // Use lighter JPEG format
        };
        img.onerror = () => reject(new Error('Image load failed'));
        
        if (source instanceof File) {
            img.src = URL.createObjectURL(source);
        } else {
            img.src = source;
        }
    });
}

function analyzeText(doc, text) {
  const u = text.toUpperCase();
  
  // Strict Category Identification based on printed title tags
  if (u.includes('GOODS RECEIVING') || u.includes('RETURNING NOTE') || u.includes('GOODS RETURN') || u.match(/\bGRN\b/)) {
      doc.type = 'GOOD RETURNING NOTE';
      const g = text.match(/(?:GRN\s*No)[.:\s]*([A-Z0-9-]+)/i);
      if (g) doc.mainNo = g[1].trim();
      const i = text.match(/(?:Inv\/DO\s*No|DO\s*No)[.:\s]*([A-Z0-9/]+)/i);
      if (i) doc.secNo = i[1].trim();
      
  } else if (u.includes('E-INVOICE') || u.includes('INVOICE') || u.includes('TAX INVOICE')) {
      doc.type = 'E-INVOICE';
      
      // IMPROVED KLIN REGEX (Supports letters at the end like 'Y')
      const k = text.match(/KLIN[A-Z0-9]{10,}/i);
      if (k) doc.mainNo = k[0].toUpperCase().replace(/O/g, '0');
      
      // Look for DOC NO specifically near the table header
      const d = text.match(/(?:Doc\s*No|Invoice\s*No)[.:\s]*([A-Z0-9-]+)/i);
      if (d) doc.secNo = d[1].trim();
  }
}

function renderDocCard(doc) {
  const card = document.createElement('div'); card.className = 'doc-card'; card.id = `card-${doc.id}`;
  card.innerHTML = `
    <div class="doc-preview">
      <div class="card-actions">
        <button class="btn-card-action" onclick="openZoom('${doc.id}')" id="zoom-btn-${doc.id}"></button>
        <button class="btn-card-action" onclick="rotateDoc('${doc.id}')" id="rotate-btn-${doc.id}"></button>
      </div>
      <img src="${doc.preview}" id="img-${doc.id}" style="transform: rotate(${doc.rotation}deg); transition: transform 0.3s;">
      <div class="processing-overlay"><span class="loader"></span><span class="status-label">Waiting...</span></div>
    </div>
    <div class="doc-info">
      <div style="display: flex; justify-content: space-between;">
        <span class="badge badge-scanning">${doc.type}</span>
        <button onclick="removeDoc('${doc.id}')" style="background:none; border:none; cursor:pointer;">✕</button>
      </div>
      <div class="doc-data" style="margin: 8px 0;">
        <div style="margin-bottom: 4px;">
           <label id="label-m-${doc.id}" style="font-size: 0.6rem; color: var(--text-muted);">MAIN NO.</label>
           <input type="text" class="doc-id-input" id="in-m-${doc.id}" onchange="logEdit('${doc.id}', 'Main', this.value)">
        </div>
        <div>
           <label id="label-s-${doc.id}" style="font-size: 0.6rem; color: var(--text-muted);">SEC NO.</label>
           <input type="text" class="doc-id-input" id="in-s-${doc.id}" onchange="logEdit('${doc.id}', 'Sec', this.value)">
        </div>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 8px;">
         <div class="progress-bar" style="flex-grow:1;"><div class="progress-fill" id="fill-${doc.id}" style="width:0%"></div></div>
         <button class="btn-history" id="btn-h-${doc.id}" onclick="showDocHistory('${doc.id}')" style="display:none; margin-left:8px;"></button>
         <button id="btn-sv-${doc.id}" class="btn btn-primary btn-sm" onclick="confirmSave('${doc.id}')" style="padding:4px 8px; font-size:0.7rem; display:none; margin-left:8px;">Save</button>
      </div>
    </div>
  `;
  if (resultsGrid) resultsGrid.appendChild(card);
  
  const zBtn = document.getElementById(`zoom-btn-${doc.id}`);
  if (zBtn) { const i = createElement(Maximize); i.setAttribute('width', '14'); i.setAttribute('height', '14'); zBtn.appendChild(i); }
  const rBtn = document.getElementById(`rotate-btn-${doc.id}`);
  if (rBtn) { const i = createElement(RotateCw); i.setAttribute('width', '14'); i.setAttribute('height', '14'); rBtn.appendChild(i); }
  const hBtn = document.getElementById(`btn-h-${doc.id}`);
  if (hBtn) { const i = createElement(History); i.setAttribute('width', '14'); i.setAttribute('height', '14'); hBtn.appendChild(i); }
  
  updateDocCard(doc);
}

function updateDocCard(doc) {
  const card = document.getElementById(`card-${doc.id}`); if (!card) return;
  const overlay = card.querySelector('.processing-overlay');
  const fill = card.querySelector('.progress-fill');
  const img = document.getElementById(`img-${doc.id}`);
  const labelM = document.getElementById(`label-m-${doc.id}`);
  const labelS = document.getElementById(`label-s-${doc.id}`);
  const inM = document.getElementById(`in-m-${doc.id}`);
  const inS = document.getElementById(`in-s-${doc.id}`);
  const saveBtn = document.getElementById(`btn-sv-${doc.id}`);

  if (img) img.style.transform = `rotate(${doc.rotation}deg)`;

  if (doc.status === 'processing') { 
      overlay.style.display = 'flex'; 
      if (!fill.style.width || fill.style.width === '0%') { 
          fill.style.width = '5%'; 
          fill.style.backgroundColor = 'hsl(0, 100%, 45%)'; // Red 
      }
      const lbl = card.querySelector('.status-label');
      if (lbl) lbl.textContent = 'Preparing Engine...';
  }
  else if (doc.status === 'done') { 
      overlay.style.display = 'none'; 
      fill.style.width = '100%'; 
      fill.style.backgroundColor = 'var(--success)'; 
      if (saveBtn) saveBtn.style.display = 'block'; 
  }
  else if (doc.status === 'error') { overlay.style.display = 'flex'; overlay.querySelector('.loader').style.display='none'; card.querySelector('.status-label').textContent='Fail'; }

  card.querySelector('.badge').textContent = doc.type;
  if (doc.type === 'E-INVOICE') { labelM.textContent = 'INV NO. (KLIN)'; labelS.textContent = 'DOC NO.'; }
  else if (doc.type === 'GOOD RETURNING NOTE') { labelM.textContent = 'GRN NO.'; labelS.textContent = 'INV/DO NO.'; }
  else { labelM.textContent = 'PRIMARY N/A'; labelS.textContent = 'SEC N/A'; }
  
  inM.value = doc.mainNo || ''; inS.value = doc.secNo || '';
  if (doc.history.length > 0) { const hb = document.getElementById(`btn-h-${doc.id}`); if(hb) hb.style.display='block'; }
}

window.rotateDoc = (id) => {
    const doc = processedDocs.find(d => d.id === id);
    if (!doc) return;
    doc.rotation = (doc.rotation || 0) + 90;
    doc.status = 'waiting'; // Trigger re-scan
    updateDocCard(doc);
    syncStorage();
    startQueueProcessing();
}

window.confirmSave = (id) => {
    const doc = processedDocs.find(d => d.id === id);
    if (!doc || !confirm("Once saved, you cannot change this record anymore. Proceed?")) return;
    if (saveToDatabase(doc)) {
        const card = document.getElementById(`card-${id}`);
        if (card) {
            const btn = document.getElementById(`btn-sv-${id}`);
            btn.textContent = 'Saved!'; btn.style.background = 'var(--success)'; btn.disabled = true;
            card.style.opacity = '0.7'; card.style.pointerEvents = 'none'; card.style.filter = 'grayscale(30%)';
        }
    }
}

window.logEdit = (id, field, val) => {
  const doc = processedDocs.find(d => d.id === id);
  if (!doc) return;
  const old = field === 'Main' ? doc.mainNo : doc.secNo;
  if (old === val) return;
  doc.history.push({ field, old, new: val, date: new Date().toLocaleTimeString() });
  if (field === 'Main') doc.mainNo = val; else doc.secNo = val;
  updateDocCard(doc); syncStorage();
}

window.showDocHistory = (id) => {
    const d = processedDocs.find(doc => doc.id === id);
    if (d) {
        if (!d.history || d.history.length === 0) {
            showCustomDialog("Audit Trail", "No manual corrections made yet.", false);
        } else {
            const changes = d.history.map(h => `[${h.date}] ${h.field}: ${h.old} -> ${h.new}`).join('\n\n');
            showCustomDialog("Audit Trail", changes, false);
        }
    }
}

window.openZoom = (id) => {
    const d = processedDocs.find(doc => doc.id === id);
    if (d) { zoomImg.src = d.preview; zoomImg.style.transform = `rotate(${d.rotation}deg)`; zoomModal.style.display = 'block'; }
}

window.removeDoc = (id) => { processedDocs = processedDocs.filter(d => d.id !== id); const el = document.getElementById(`card-${id}`); if(el) el.remove(); syncStorage(); }

window.confirmSave = (id) => {
    const doc = processedDocs.find(d => d.id === id);
    if (!doc) {
        showCustomDialog("Error", "System error: Document reference lost.", false);
        return;
    }
    
    // Custom Confirmation Prompt (Unblockable)
    showCustomDialog(
        "Confirm Verification",
        `Are you sure you want to verify and save document ${doc.mainNo || '(Unknown ID)'} into the Enterprise Database?`,
        true,
        async () => {
            const success = await saveToDatabase(doc);
            if (success) {
                const card = document.getElementById(`card-${id}`);
                const btn = document.getElementById(`btn-sv-${id}`);
                if (btn) { btn.textContent = 'Saved!'; btn.style.background = 'var(--success)'; btn.disabled = true; }
                if (card) { card.style.opacity = '0.7'; card.style.pointerEvents = 'none'; card.style.filter = 'grayscale(30%)'; }
            }
        }
    );
}

// Custom UI Dialog system to replace native alert/confirm
window.showCustomDialog = (title, message, isConfirm, onConfirm) => {
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); z-index:9999; display:flex; align-items:center; justify-content:center; backdrop-filter:blur(3px);';
    
    const box = document.createElement('div');
    box.style.cssText = 'background:white; padding:24px; border-radius:12px; width:400px; max-width:90%; box-shadow:0 10px 25px rgba(0,0,0,0.2); animation: scaleIn 0.2s ease-out;';
    
    box.innerHTML = `
        <h3 style="margin-top:0; color:var(--text); font-size:1.2rem; font-weight:700;">${title}</h3>
        <p style="color:var(--text-muted); line-height:1.5; margin-bottom:24px; white-space:pre-wrap;">${message}</p>
        <div style="display:flex; justify-content:flex-end; gap:12px;">
            ${isConfirm ? `<button id="cd-cancel" class="btn btn-outline" style="padding:8px 16px;">Cancel</button>` : ''}
            <button id="cd-ok" class="btn btn-primary" style="padding:8px 16px;">${isConfirm ? 'Confirm & Save' : 'OK'}</button>
        </div>
    `;
    
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    
    const close = () => overlay.remove();
    
    document.getElementById('cd-ok').onclick = () => { close(); if (onConfirm) onConfirm(); };
    if (isConfirm) document.getElementById('cd-cancel').onclick = close;
}

async function initWorkers() {
    if (workerPool.length > 0) return;
    for (let i = 0; i < MAX_WORKERS; i++) { 
        const poolObj = { busy: false, currentDocId: null };
        const w = await createWorker('eng', 1, {
            logger: m => {
                if (m.status === 'recognizing text' && poolObj.currentDocId) {
                    const fill = document.getElementById(`fill-${poolObj.currentDocId}`);
                    const lbl = document.querySelector(`#card-${poolObj.currentDocId} .status-label`);
                    const pct = Math.round(m.progress * 100);
                    
                    if (fill) {
                        fill.style.width = Math.max(20, pct) + '%';
                        const hue = Math.min(120, Math.floor(pct * 1.2)); // 0% = Red(0), 100% = Green(120)
                        fill.style.backgroundColor = `hsl(${hue}, 100%, 45%)`;
                    }
                    if (lbl) lbl.textContent = `Scanning... ${pct}%`;
                }
            }
        });
        poolObj.worker = w;
        workerPool.push(poolObj); 
    }
}

async function getAvailableWorker() {
    let w = workerPool.find(o => !o.busy);
    while (!w) { await new Promise(r => setTimeout(r, 200)); w = workerPool.find(o => !o.busy); }
    w.busy = true; return w;
}

function showStatus(text, type) {
  const b = document.getElementById('status-banner'); if (!b) return;
  b.style.display = 'flex'; document.getElementById('status-text').textContent = text;
  const iconBox = document.getElementById('status-icon'); iconBox.innerHTML = '';
  const icon = createElement(type === 'loading' ? Scan : (type === 'success' ? CheckCircle : AlertCircle));
  icon.setAttribute('width', '20'); icon.setAttribute('height', '20'); iconBox.appendChild(icon);
  b.style.background = type === 'loading' ? 'var(--primary)' : (type === 'success' ? 'var(--success)' : '#ef4444');
}

if (dropZone) {
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); handleFiles(e.dataTransfer.files); });
}
if (fileInput) fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
if (cameraInput) cameraInput.addEventListener('change', (e) => handleFiles(e.target.files));
if (dbSearchInput) dbSearchInput.addEventListener('input', () => { currentPage = 1; renderDatabase(); });
if (dbFilterSelect) dbFilterSelect.addEventListener('change', () => { currentPage = 1; renderDatabase(); });
if (exportCsvBtn) {
    exportCsvBtn.onclick = () => {
        if (database.length === 0) return;
        const csv = "Main No,Sec No,Category,Date\n" + database.map(r => `"${r.docNo}","${r.refNo}","${r.category}","${r.processDate}"`).join("\n");
        const l = document.createElement('a'); l.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); l.download = 'export.csv'; l.click();
    };
}

if (clearAllBtn) {
    clearAllBtn.addEventListener('click', () => {
        // Instant visual feedback
        clearAllBtn.textContent = 'Clearing...';
        clearAllBtn.style.opacity = '0.5';
        
        setTimeout(() => {
            if (processedDocs.length === 0) {
                clearAllBtn.textContent = 'Clear All';
                clearAllBtn.style.opacity = '1';
                alert("The workspace is already clear.");
                return;
            }
            
            processedDocs = [];
            document.querySelectorAll('.doc-card').forEach(el => el.remove());
            
            const es = document.getElementById('empty-state');
            if (es) es.style.display = 'block';
            
            const banner = document.getElementById('status-banner');
            if (banner) banner.style.display = 'none';
            
            syncStorage();
            updateStats();
            
            clearAllBtn.textContent = 'Clear All';
            clearAllBtn.style.opacity = '1';
        }, 50);
    });
}

// Global error handler for diagnostic
window.onerror = function(msg, url, line, col, error) {
   console.error("UI Error: " + msg);
};

init();
