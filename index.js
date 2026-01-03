const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');
const paypal = require('@paypal/checkout-server-sdk');
const logger = require('./logger'); // [NEW] Import Logger

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// [NEW] Request Logging Middleware
app.use((req, res, next) => {
    logger.info(`Incoming Request: ${req.method} ${req.url} - IP: ${req.ip}`);
    next();
});

// Initialize Firebase Admin
// NOTE: You need to set GOOGLE_APPLICATION_CREDENTIALS or manually initialize with service account
// For now, we'll try to use default credentials or a specific path if provided in .env
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
        // Priority 1: JSON String content (Best for Render/Heroku)
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

        // Critical Fix: Replace literal \n with actual newlines if they were escaped
        if (serviceAccount.private_key) {
            serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        }

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
        // Priority 2: Local File Path
        const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } else {
        // Priority 3: Default (Google Cloud/Firebase Hosting environment)
        admin.initializeApp();
    }
    logger.info("Firebase Admin Initialized");
} catch (error) {
    logger.warn(`Firebase Admin Initialization Warning: ${error.message}`);
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

let db;
try {
    db = admin.firestore();
} catch (error) {
    logger.error(`Error initializing Firestore: ${error.message}`);
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const PORT = process.env.PORT || 5000;

app.post('/api/explain-exam', async (req, res) => {
    try {
        const { examId, examTitle, questions } = req.body;

        if (!examId || !questions || !Array.isArray(questions)) {
            logger.warn('Invalid request data for explain-exam');
            return res.status(400).json({ error: "Invalid request data" });
        }

        // 1. Check Cache in Firestore
        const explanationRef = db.collection('exam_explanations').doc(examId);
        const docSnap = await explanationRef.get();

        if (docSnap.exists) {
            logger.info(`[Cache Hit] Serving explanations for exam: ${examId}`);
            return res.json({ explanations: docSnap.data().explanations });
        }

        logger.info(`[Cache Miss] Generating AI explanations for exam: ${examId} (${questions.length} questions)`);

        // 2. Prepare Bulk Prompt for Gemini
        // Model rotation logic
        const models = ["gemini-2.5-flash", "gemini-3-flash", "gemini-2.5-flash-lite"];
        let explanations = null;
        let lastError = null;

        const prompt = `
            You are an expert tutor. I will provide a list of quiz questions. 
            For EACH question, provide a concise but clear explanation (2-3 sentences max) of WHY the correct option is the right answer.
            
            Exam Title: ${examTitle}

            Questions Payload:
            ${JSON.stringify(questions.map(q => ({
            id: q.id,
            text: q.text,
            options: q.options,
            correctOption: q.options[q.correctIndex]
        })))}

            INSTRUCTIONS:
            - Return ONLY a valid JSON object.
            - The keys of the object MUST be the question IDs provided in the payload.
            - The values MUST be the explanation strings.
            - Do not include markdown formatting like \`\`\`json. Just the raw JSON string.
        `;

        for (const modelName of models) {
            try {
                logger.info(`Trying model: ${modelName}...`);
                const model = genAI.getGenerativeModel({ model: modelName });
                const result = await model.generateContent(prompt);
                const response = await result.response;
                let text = response.text();

                // Cleanup markdown if present
                text = text.replace(/```json/g, '').replace(/```/g, '').trim();

                explanations = JSON.parse(text);
                logger.info(`Success with model: ${modelName}`);
                break; // Exit loop on success
            } catch (error) {
                logger.warn(`Failed with model ${modelName}: ${error.message}`);
                lastError = error;
                // Continue to next model
            }
        }

        if (!explanations) {
            throw new Error(`All models failed. Last error: ${lastError ? lastError.message : 'Unknown error'}`);
        }

        // 3. Store in Firestore
        await explanationRef.set({
            examId,
            examTitle: examTitle || 'Unknown',
            explanations,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ explanations });

    } catch (error) {
        logger.error(`Error generating explanations: ${error.stack}`);
        res.status(500).json({ error: "Failed to generate explanations", details: error.message });
    }
});

// PayPal Configuration
const environment = () => {
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

    if (process.env.NODE_ENV === 'production') {
        return new paypal.core.LiveEnvironment(clientId, clientSecret);
    }
    // Default to Sandbox
    return new paypal.core.SandboxEnvironment(clientId, clientSecret);
};

const paypalClient = () => {
    return new paypal.core.PayPalHttpClient(environment());
};

// PayPal Endpoints
app.post('/api/paypal/create-order', async (req, res) => {
    try {
        const { amount, currency } = req.body;

        if (!amount) {
            logger.warn('PayPal Create Order Failed: Missing Amount');
            return res.status(400).json({ error: "Amount is required" });
        }

        const request = new paypal.orders.OrdersCreateRequest();
        request.prefer("return=representation");
        request.requestBody({
            intent: 'CAPTURE',
            purchase_units: [{
                amount: {
                    currency_code: currency || 'USD',
                    value: amount.toString()
                }
            }]
        });

        const order = await paypalClient().execute(request);
        logger.info(`PayPal Order Created: ${order.result.id} (${amount} ${currency || 'USD'})`);
        res.json({ id: order.result.id });
    } catch (e) {
        logger.error(`PayPal Create Order Error: ${e.message}`);
        res.status(500).json({ error: "Failed to create PayPal order: " + e.message });
    }
});

app.post('/api/paypal/capture-order', async (req, res) => {
    try {
        const { orderID } = req.body;

        if (!orderID) {
            logger.warn('PayPal Capture Failed: Missing OrderID');
            return res.status(400).json({ error: "Order ID is required" });
        }

        const request = new paypal.orders.OrdersCaptureRequest(orderID);
        request.requestBody({});

        const capture = await paypalClient().execute(request);

        logger.info(`PayPal Payment Captured: ${capture.result.id} by ${capture.result.payer.name.given_name}`);

        // Return minimal necessary data
        res.json({
            status: capture.result.status,
            id: capture.result.id,
            payer: capture.result.payer
        });
    } catch (e) {
        logger.error(`PayPal Capture Order Error: ${e.message}`);
        res.status(500).json({ error: "Failed to capture PayPal order: " + e.message });
    }
});

app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
});
