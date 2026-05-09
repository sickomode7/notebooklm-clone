import express from 'express';
import multer from 'multer';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { QdrantClient } from '@qdrant/js-client-rest';
import { pipeline } from '@xenova/transformers';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Setup multer for uploads (using memory storage to avoid missing directory errors on serverless/Railway)
const upload = multer({ storage: multer.memoryStorage() });

// Initialize Qdrant Client
const qdrantClient = new QdrantClient({ 
    url: process.env.QDRANT_URL || 'http://localhost:6333',
    apiKey: process.env.QDRANT_API_KEY
});


// Initialize Gemini Client (for Google AI Studio API)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Initialize Transformer Pipeline (lazy load to avoid blocking startup)
let extractor;
async function getExtractor() {
    if (!extractor) {
        console.log('Loading embedding model...');
        extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        console.log('Embedding model loaded.');
    }
    return extractor;
}

// Ensure Qdrant collection exists
async function initQdrant() {
    try {
        const collections = await qdrantClient.getCollections();
        const exists = collections.collections.some(c => c.name === COLLECTION_NAME);
        if (!exists) {
            await qdrantClient.createCollection(COLLECTION_NAME, {
                vectors: { size: 384, distance: 'Cosine' }
            });
            console.log(`Collection ${COLLECTION_NAME} created.`);
        } else {
            console.log(`Collection ${COLLECTION_NAME} already exists.`);
        }
    } catch (error) {
        console.error('Error initializing Qdrant. Make sure Qdrant is running:', error.message);
    }
}
initQdrant();

/**
 * Chunks text using a sliding window strategy.
 * - Chunk size: 500 characters
 * - Overlap: 100 characters
 * This strategy ensures context is preserved across chunk boundaries.
 * Each chunk is returned alongside metadata indicating the source filename and chunk index.
 */
function chunkText(text, filename) {
    const chunkSize = 500;
    const overlap = 100;
    const chunks = [];
    let i = 0;
    let start = 0;

    while (start < text.length) {
        const end = Math.min(start + chunkSize, text.length);
        const chunkText = text.slice(start, end);
        
        chunks.push({
            text: chunkText,
            metadata: { source: filename, chunkIndex: i }
        });
        
        if (end === text.length) break;
        
        i++;
        start += (chunkSize - overlap);
    }
    
    return chunks;
}

// Endpoint to upload and process PDF or TXT
app.post('/upload', upload.single('document'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send({ error: 'No file uploaded.' });

        const originalName = req.file.originalname;
        const dataBuffer = req.file.buffer;
        
        let text = '';
        
        // Extract text based on file type
        if (originalName.toLowerCase().endsWith('.pdf')) {
            const data = await pdfParse(dataBuffer);
            text = data.text;
        } else if (originalName.toLowerCase().endsWith('.txt')) {
            text = dataBuffer.toString('utf-8');
        } else {
            return res.status(400).send({ error: 'Unsupported file type. Only PDF and TXT are allowed.' });
        }

        // Chunk text using sliding window
        const chunks = chunkText(text, originalName);
        
        // Create collection name from filename (sanitized, lowercase)
        let collectionName = originalName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        if (!collectionName) {
            collectionName = 'default-collection';
        }

        // Create collection if not exists
        const collections = await qdrantClient.getCollections();
        const exists = collections.collections.some(c => c.name === collectionName);
        if (!exists) {
            await qdrantClient.createCollection(collectionName, {
                vectors: { size: 384, distance: 'Cosine' }
            });
            console.log(`Collection ${collectionName} created.`);
        }
        
        // Generate Embeddings and Store
        const generateEmbeddings = await getExtractor();
        
        const points = [];
        for (const chunk of chunks) {
            const chunkContent = chunk.text.trim();
            if (!chunkContent) continue;

            const output = await generateEmbeddings(chunkContent, { pooling: 'mean', normalize: true });
            points.push({
                id: crypto.randomUUID(),
                vector: Array.from(output.data),
                payload: { 
                    content: chunkContent,
                    source: chunk.metadata.source,
                    chunkIndex: chunk.metadata.chunkIndex
                }
            });
        }

        if (points.length > 0) {
            await qdrantClient.upsert(collectionName, {
                wait: true,
                points: points
            });
        }

        res.json({ success: true, collectionName, chunksIndexed: points.length });
    } catch (error) {
        console.error('Upload Error:', error);
        res.status(500).send({ error: 'Error processing document.' });
    }
});

// Endpoint to chat with the document
app.post('/chat', async (req, res) => {
    try {
        const { question, collectionName } = req.body;
        if (!question || !collectionName) {
            return res.status(400).send({ error: 'Both question and collectionName are required.' });
        }

        // Generate query embedding
        const generateEmbeddings = await getExtractor();
        const output = await generateEmbeddings(question, { pooling: 'mean', normalize: true });
        const queryVector = Array.from(output.data);

        // Search Qdrant for top 4 nearest chunks
        const searchResults = await qdrantClient.search(collectionName, {
            vector: queryVector,
            limit: 4,
            with_payload: true
        });

        // Construct Context from search results and extract sources
        const sources = [];
        const contextChunks = searchResults.map(r => {
            const chunkIndex = r.payload.chunkIndex;
            sources.push(chunkIndex);
            return `[Chunk ${chunkIndex}]\n${r.payload.content}`;
        });
        const context = contextChunks.join('\n\n');

        const fullPrompt = `You are a document assistant. Answer ONLY using the context below.
If the answer is not in the context, say "I couldn't find that in the document."

Context:
${context}

Question: ${question}
Answer:`;

        // Call LLM using Google AI Studio
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
        });
        
        const answer = response.candidates[0].content.parts[0].text;

        res.json({ answer, sources });
    } catch (error) {
        console.error('Chat Error:', error);
        res.status(500).send({ error: 'Error generating response.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
