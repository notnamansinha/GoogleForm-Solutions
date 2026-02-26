// geminiService.js - API integration (fast model fallback)

async function getGeminiApiKey() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['geminiApiKey'], (result) => {
            resolve(result.geminiApiKey);
        });
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function setStatus(msg) {
    chrome.storage.local.set({ geminiStatus: msg });
    try { chrome.runtime.sendMessage({ action: "UPDATE_STATUS", status: msg }); } catch (e) { }
}

// Try models in fast sequence — don't wait long, just skip to next
const MODELS = [
    "gemini-2.0-flash-lite",
    "gemini-2.0-flash",
    "gemini-1.5-flash"
];

async function callGeminiOnce(prompt, apiKey, model) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                temperature: 0.1,
                responseMimeType: "application/json"
            }
        })
    });

    if (response.status === 429) {
        return { rateLimited: true };
    }
    if (response.status === 404) {
        return { notFound: true };
    }
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`${response.status}: ${body}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Empty response from Gemini");
    return { data: JSON.parse(text) };
}

async function callGeminiFast(prompt, apiKey) {
    // Round 1: Try each model with just 1s gap
    for (const model of MODELS) {
        setStatus(`Trying ${model}...`);
        console.log(`[Round 1] Trying ${model}...`);
        try {
            const result = await callGeminiOnce(prompt, apiKey, model);
            if (result.data) return result.data;
            if (result.rateLimited) {
                console.warn(`[${model}] 429, skipping to next model...`);
                await sleep(1000);
                continue;
            }
            if (result.notFound) continue;
        } catch (err) {
            console.error(`[${model}] Error:`, err.message);
            // If it's an auth error, throw immediately
            if (err.message.includes("API_KEY") || err.message.includes("401") || err.message.includes("403")) {
                throw new Error("Invalid or expired API key. Please generate a new one at aistudio.google.com");
            }
            continue;
        }
    }

    // Round 2: All models were rate limited. Wait 60s then try once more.
    setStatus("All models busy. Waiting 60s...");
    console.warn("All models rate-limited. Waiting 60s for quota reset...");
    await sleep(60000);

    for (const model of MODELS) {
        setStatus(`Retrying ${model}...`);
        try {
            const result = await callGeminiOnce(prompt, apiKey, model);
            if (result.data) return result.data;
            if (result.rateLimited) { await sleep(1000); continue; }
            if (result.notFound) continue;
        } catch (err) {
            continue;
        }
    }

    throw new Error("All models exhausted. Wait 2 min and try again.");
}

// Global entry — called by content.js
window.handleGeminiAnswers = async function (pageText) {
    try {
        const apiKey = await getGeminiApiKey();
        if (!apiKey) {
            setStatus("Error: No API key. Enter one in the popup.");
            return;
        }

        setStatus("Sending to Gemini...");

        const prompt = `You are an expert at answering multiple choice questions. Below is the full text of a Google Form page. 

Your task:
1. Identify ONLY the multiple choice questions (radio buttons = single answer, checkboxes = multiple answers).
2. Skip any non-MCQ questions (text inputs, date pickers, dropdowns, file uploads, etc.).
3. For each MCQ, determine the correct answer(s).

Return a JSON array where each element is:
{"question": "<first few words of the question>", "answers": ["<exact option text>"]}

For single-answer questions, return exactly 1 answer. For multiple-answer (checkbox) questions, return all correct answers.
Match option text EXACTLY as it appears in the form.
Return ONLY the JSON array, nothing else.

--- FORM TEXT START ---
${pageText}
--- FORM TEXT END ---`;

        const answersJson = await callGeminiFast(prompt, apiKey);
        console.log("Gemini answers:", answersJson);

        setStatus("Selecting answers...");

        if (typeof window.applyAnswersToForm === 'function') {
            window.applyAnswersToForm(answersJson);
            setStatus("Done ✅");
        } else {
            setStatus("Error: page not ready. Reload and try again.");
        }

    } catch (err) {
        console.error("Gemini API Error:", err);
        setStatus(`Error: ${err.message}`);
    }
};
