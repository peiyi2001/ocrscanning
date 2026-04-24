import { defineConfig } from 'vite';
import express from 'express';
import fs from 'fs';
import path from 'path';
import PDFDocument from 'pdfkit';

const eInvoiceDir = 'C:\\Users\\ylcs_peiyi.lai\\OneDrive - Yee Lee Corporation Bhd\\OCR\\E-Invoice';
const grnDir = 'C:\\Users\\ylcs_peiyi.lai\\OneDrive - Yee Lee Corporation Bhd\\OCR\\GRN';
const otherDir = 'C:\\Users\\ylcs_peiyi.lai\\OneDrive - Yee Lee Corporation Bhd\\OCR\\Other_Formats';
const masterDbFile = 'C:\\Users\\ylcs_peiyi.lai\\OneDrive - Yee Lee Corporation Bhd\\OCR\\database.json';

function ensureDirs() {
    [eInvoiceDir, grnDir, otherDir].forEach(d => {
        if (!fs.existsSync(d)) {
            try {
                fs.mkdirSync(d, { recursive: true });
            } catch(e) { console.error("Error creating dir", e); }
        }
    });
}

function ocrBackendPlugin() {
    return {
        name: 'ocr-backend',
        configureServer(server) {
            const app = express();
            app.use(express.json({ limit: '100mb' }));
            
            ensureDirs();

            app.get('/api/database', (req, res) => {
                if (fs.existsSync(masterDbFile)) {
                    res.json(JSON.parse(fs.readFileSync(masterDbFile, 'utf8')));
                } else {
                    res.json([]);
                }
            });

            app.post('/api/save', (req, res) => {
                const doc = req.body.doc;
                const imageBase64 = req.body.imageBase64;
                
                try {
                    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
                    const buffer = Buffer.from(base64Data, 'base64');
                    
                    const safeDate = new Date().toISOString().slice(0,10).replace(/-/g, '') + '_' + Date.now().toString().slice(-4);
                    const safeName = `${doc.mainNo || 'UNNAMED'}_${safeDate}`;
                    
                    let targetDir = otherDir;
                    if (doc.type === 'E-INVOICE') targetDir = eInvoiceDir;
                    else if (doc.type === 'GOOD RETURNING NOTE') targetDir = grnDir;
                    
                    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
                    
                    // 1. Save JPG
                    const jpgPath = path.join(targetDir, `${safeName}.jpg`);
                    fs.writeFileSync(jpgPath, buffer);
                    
                    // 2. Build PDF from the identical image buffer
                    const pdfPath = path.join(targetDir, `${safeName}.pdf`);
                    const pdfDoc = new PDFDocument({ autoFirstPage: false });
                    const pdfStream = fs.createWriteStream(pdfPath);
                    pdfDoc.pipe(pdfStream);
                    
                    const img = pdfDoc.openImage(buffer);
                    pdfDoc.addPage({ size: [img.width, img.height] });
                    pdfDoc.image(img, 0, 0, { width: img.width, height: img.height });
                    pdfDoc.end();
                    
                    // 3. Update Database
                    let db = [];
                    if (fs.existsSync(masterDbFile)) {
                        db = JSON.parse(fs.readFileSync(masterDbFile, 'utf8'));
                    }
                    
                    const now = new Date();
                    const record = {
                        docNo: doc.mainNo || 'N/A',
                        refNo: doc.secNo || 'N/A',
                        category: doc.type || 'UNKNOWN',
                        processDate: now.toLocaleString(),
                        timestamp: now.toISOString(),
                        status: 'Verified',
                        history: doc.history || [],
                        id: doc.id,
                        queueId: doc.id,
                        files: [ `${safeName}.jpg`, `${safeName}.pdf` ]
                    };
                    db.unshift(record);
                    
                    fs.writeFileSync(masterDbFile, JSON.stringify(db, null, 2));
                    
                    res.json({ success: true, record, db });
                } catch (e) {
                    console.error("API Save Error", e);
                    res.status(500).json({ error: e.message });
                }
            });

            app.delete('/api/delete/:id', (req, res) => {
                try {
                    const id = req.params.id;
                    if (fs.existsSync(masterDbFile)) {
                        let db = JSON.parse(fs.readFileSync(masterDbFile, 'utf8'));
                        // Optional: Could also delete actual files here, but for now just removing DB record
                        db = db.filter(r => String(r.id) !== String(id));
                        fs.writeFileSync(masterDbFile, JSON.stringify(db, null, 2));
                        res.json({ success: true, db });
                    } else {
                        res.json({ success: true, db: [] });
                    }
                } catch (e) {
                    res.status(500).json({ error: e.message });
                }
            });

            server.middlewares.use(app);
        }
    };
}

export default defineConfig({
    plugins: [ocrBackendPlugin()],
    server: {
        host: true  // Allow access from other devices on the same network
    }
});
