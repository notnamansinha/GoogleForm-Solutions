// geminiService.js - API integration

async function getGeminiApiKey() {
    return new Promise((resolve) => {
        chrome.storage.local.get(['geminiApiKey'], (result) => {
            resolve(result.geminiApiKey);
        });
    });
}

async function callGemini(prompt, apiKey) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            contents: [{
                parts: [{ text: prompt }]
            }],
            generationConfig: {
                temperature: 0.1,
                responseMimeType: "application/json"
            }
        })
    });

    if (!response.ok) {
        if (response.status === 429) {
            throw new Error("Rate limit exceeded (429). Please wait and try again.");
        }
        throw new Error(`API Error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("No text returned from Gemini");

    return JSON.parse(text);
}

// Global function that content.js calls
window.handleGeminiAnswers = async function (scrapedData) {
    try {
        const apiKey = await getGeminiApiKey();
        if (!apiKey) {
            chrome.runtime.sendMessage({ action: "UPDATE_STATUS", status: "Error: No API Key found in settings." });
            return;
        }

        const BATCH_SIZE = 5;
        const DELAY_MS = 2000; // 2 seconds delay between batches

        for (let i = 0; i < scrapedData.length; i += BATCH_SIZE) {
            const batch = scrapedData.slice(i, i + BATCH_SIZE);
            const batchNum = Math.floor(i / BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(scrapedData.length / BATCH_SIZE);

            chrome.runtime.sendMessage({ action: "UPDATE_STATUS", status: `Fetching answers... (Batch ${batchNum} of ${totalBatches})` });

            let promptText = "You are an automated assistant designed to answer multiple choice questions from a test or survey. I will provide a list of questions along with their unique IDs and possible options.\n\n" +
                "Task: For each question, determine the correct answer(s) and return a JSON array of objects. Each object MUST contain:\n" +
                "- \"id\": the exact integer ID provided for the question.\n" +
                "- \"answer\": an array of strings containing the exact text of the correct option(s).\n\n" +
                "Important: Your entire response must be ONLY a valid JSON array and nothing else. Ensure the answer text matches the provided options exactly or as closely as possible.\n\n" +
                "Questions:\n";

            batch.forEach(q => {
                promptText += `ID: ${q.id}\n`;
                promptText += `Type: ${q.type}\n`;
                promptText += `Question: ${q.question}\n`;
                promptText += `Options: ${JSON.stringify(q.options)}\n\n`;
            });

            console.log(`Gemini Forms Helper: Sending batch ${batchNum} to Gemini...`, promptText);

            let retries = 3;
            let success = false;
            while (retries > 0 && !success) {
                try {
                    const answersJson = await callGemini(promptText, apiKey);
                    console.log(`Gemini Forms Helper: Received answers for batch ${batchNum}:`, answersJson);

                    // Call back to content.js to apply the answers incrementally
                    if (typeof window.applyAnswersToForm === 'function') {
                        window.applyAnswersToForm(scrapedData, answersJson);
                    } else {
                        console.warn("applyAnswersToForm function not found.");
                    }

                    success = true;

                    // Delay before next batch if there are more
                    if (i + BATCH_SIZE < scrapedData.length) {
                        await new Promise(resolve => setTimeout(resolve, DELAY_MS));
                    }
                } catch (err) {
                    if (err.message.includes("429")) {
                        console.warn(`Rate limit hit. Waiting 5 seconds before retrying... (${retries} retries left)`);
                        chrome.runtime.sendMessage({ action: "UPDATE_STATUS", status: `Rate limit hit. Retrying in 5s... (${retries} left)` });
                        await new Promise(resolve => setTimeout(resolve, 5000));
                        retries--;
                    } else {
                        throw err; // Re-throw other errors
                    }
                }
            }
            if (!success) {
                throw new Error("Failed after multiple retries due to rate limiting.");
            }
        }

        chrome.runtime.sendMessage({ action: "UPDATE_STATUS", status: "Done ✅ Answers applied!" });

    } catch (err) {
        console.error("Gemini Forms Helper API Error:", err);
        chrome.runtime.sendMessage({ action: "UPDATE_STATUS", status: `Error: ${err.message}` });
    }
};
