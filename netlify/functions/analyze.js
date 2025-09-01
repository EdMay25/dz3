const fetch = require('node-fetch');
const Busboy = require('busboy');
const { Buffer } = require('buffer');
const { Storage } = require('@google-cloud/storage');

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const CLOUDMERSIVE_API_KEY = process.env.CLOUDMERSIVE_API_KEY;
    const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;
    const HUGGING_FACE_API_KEY = process.env.HUGGING_FACE_API_KEY;

    try {
        let extractedText = '';
        let sourceLanguage = 'auto';
        let targetLanguage = 'ru';
        let inputType = '';
        let fileBuffer = null;
        let fileName = '';
        let fileMimeType = '';

        console.log('--- Netlify Function Start ---');
        console.log('Event HTTP Method:', event.httpMethod);
        console.log('Event Headers:', event.headers);
        console.log('Event isBase64Encoded:', event.isBase64Encoded);

        const contentType = event.headers['content-type'];
        if (!contentType || !contentType.includes('multipart/form-data')) {
            console.error('Invalid Content-Type. Expected multipart/form-data.');
            return { statusCode: 400, body: 'Invalid Content-Type. Expected multipart/form-data.' };
        }

        await new Promise((resolve, reject) => {
            const busboy = Busboy({ headers: event.headers });

            busboy.on('file', (fieldname, file, filename, encoding, mimetype) => {
                console.log(`File [${fieldname}]: filename=${filename}, mimetype=${mimetype}`);
                const chunks = [];
                file.on('data', data => chunks.push(data));
                file.on('end', () => {
                    fileBuffer = Buffer.concat(chunks);
                    fileName = filename;
                    fileMimeType = mimetype;
                });
            });

            busboy.on('field', (fieldname, val, fieldnameTruncated, valTruncated, encoding, mimetype) => {
                console.log(`Field [${fieldname}]: value: ${val}`);
                if (fieldname === 'sourceLanguage') sourceLanguage = val;
                if (fieldname === 'targetLanguage') targetLanguage = val;
                if (fieldname === 'inputType') inputType = val;
                if (fieldname === 'text') extractedText = val;
            });

            busboy.on('finish', resolve);
            busboy.on('error', reject);

            if (event.isBase64Encoded) {
                busboy.end(Buffer.from(event.body, 'base64'));
            } else {
                busboy.end(event.body);
            }
        });

        console.log('Parsed inputType:', inputType);
        console.log('Parsed sourceLanguage:', sourceLanguage);
        console.log('Parsed targetLanguage:', targetLanguage);
        console.log('Extracted Text (from text input):', extractedText.substring(0, Math.min(extractedText.length, 100)) + '...');
        console.log('File Name:', fileName);
        console.log('File MIME Type:', fileMimeType);

        if ((inputType === 'file' || inputType === 'image') && fileBuffer) {
            let ocrEndpoint = '';
            if (fileMimeType.startsWith('image/')) {
                ocrEndpoint = 'https://api.cloudmersive.com/ocr/image/toText';
            } else if (fileMimeType === 'application/pdf') {
                ocrEndpoint = 'https://api.cloudmersive.com/ocr/pdf/toText';
            } else if (fileMimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                ocrEndpoint = 'https://api.cloudmersive.com/convert/docx/to/txt';
            } else if (fileMimeType === 'text/plain') {
                extractedText = fileBuffer.toString('utf8');
                console.log('Extracted Text (from text/plain file):', extractedText.substring(0, Math.min(extractedText.length, 100)) + '...');
            } else {
                console.error('Unsupported file type for OCR/conversion:', fileMimeType);
                return { statusCode: 400, body: JSON.stringify({ message: 'Неподдерживаемый тип файла для OCR/конвертации.' }) };
            }

            if (ocrEndpoint) {
                console.log('OCR Endpoint:', ocrEndpoint);
                const formData = new FormData();
                formData.append('inputFile', fileBuffer, {
                    filename: fileName,
                    contentType: fileMimeType
                });

                const ocrResponse = await fetch(ocrEndpoint, {
                    method: 'POST',
                    headers: {
                        'Apikey': CLOUDMERSIVE_API_KEY
                    },
                    body: formData
                });

                if (!ocrResponse.ok) {
                    const errorText = await ocrResponse.text();
                    console.error('Cloudmersive OCR/Convert Error:', ocrResponse.status, errorText);

                    // Fallback to Google Cloud Vision API for PDF
                    if (fileMimeType === 'application/pdf') {
                        console.log('Falling back to Google Cloud Vision API for PDF OCR');
                        try {
                            const storage = new Storage();
                            const bucketName = 'dz3test'; // Replace with your bucket name
                            const destinationBucketName = 'dz3test'; // Replace with your bucket name
                            const sourceFileName = `temp_${Date.now()}_${fileName}`;
                            const destinationFileName = `output_${Date.now()}_${fileName.replace('.pdf', '.json')}`;

                            // Upload file to Google Cloud Storage
                            const bucket = storage.bucket(bucketName);
                            const file = bucket.file(sourceFileName);
                            await file.save(fileBuffer, {
                                metadata: { contentType: fileMimeType },
                            });

                            const gcsSourceUri = `gs://${bucketName}/${sourceFileName}`;
                            const gcsDestinationUri = `gs://${destinationBucketName}/`;

                            // Call Google Cloud Vision API
                            const visionResponse = await fetch(`https://vision.googleapis.com/v1/files:asyncBatchAnnotate?key=${process.env.GOOGLE_CLOUD_VISION_API_KEY}`, {
                                method: 'POST',
                                headers: {
                                    'Content-Type': 'application/json',
                                },
                                body: JSON.stringify({
                                    requests: [
                                        {
                                            inputConfig: {
                                                gcsSource: {
                                                    uri: gcsSourceUri,
                                                },
                                                mimeType: fileMimeType,
                                            },
                                            features: [
                                                {
                                                    type: 'DOCUMENT_TEXT_DETECTION',
                                                },
                                            ],
                                            outputConfig: {
                                                gcsDestination: {
                                                    uri: gcsDestinationUri,
                                                },
                                                batchSize: 1,
                                            },
                                        },
                                    ],
                                }),
                            });

                            if (!visionResponse.ok) {
                                const visionErrorText = await visionResponse.text();
                                console.error('Google Cloud Vision API Error:', visionResponse.status, visionErrorText);
                                return {
                                    statusCode: visionResponse.status,
                                    body: JSON.stringify({ message: 'Ошибка при распознавании текста из файла через Google Cloud Vision API.', details: visionErrorText })
                                };
                            }

                            const visionData = await visionResponse.json();
                            console.log('Google Cloud Vision API Response:', JSON.stringify(visionData));

                            // Wait for the operation to complete and fetch the result
                            const operationName = visionData.name;
                            let operationStatusResponse;
                            let operationStatusData;

                            // Polling for operation completion
                            let attempts = 0;
                            const maxAttempts = 10;
                            const delay = 2000; // 2 seconds

                            while (attempts < maxAttempts) {
                                operationStatusResponse = await fetch(`https://vision.googleapis.com/v1/${operationName}?key=${process.env.GOOGLE_CLOUD_VISION_API_KEY}`);
                                operationStatusData = await operationStatusResponse.json();

                                if (operationStatusData.done) {
                                    break;
                                }

                                await new Promise(resolve => setTimeout(resolve, delay));
                                attempts++;
                            }

                            if (!operationStatusData.done) {
                                return {
                                    statusCode: 504,
                                    body: JSON.stringify({ message: 'Таймаут ожидания завершения операции Google Cloud Vision API.' })
                                };
                            }

                            // Fetch the result from Google Cloud Storage
                            const outputFileName = operationStatusData.response.responses[0].outputConfig.gcsDestination.uri.split('/').pop();
                            const outputFile = bucket.file(outputFileName);
                            const [outputFileData] = await outputFile.download();

                            const outputJson = JSON.parse(outputFileData.toString('utf8'));
                            extractedText = outputJson.responses[0].fullTextAnnotation.text;
                            console.log('Extracted Text (from Google Cloud Vision API):', extractedText.substring(0, Math.min(extractedText.length, 100)) + '...');
                        } catch (fallbackError) {
                            console.error('Fallback to Google Cloud Vision API failed:', fallbackError);
                            return {
                                statusCode: 500,
                                body: JSON.stringify({ message: 'Ошибка при попытке резервного распознавания текста из файла.', details: fallbackError.message })
                            };
                        }
                    } else {
                        return {
                            statusCode: ocrResponse.status,
                            body: JSON.stringify({ message: 'Ошибка при распознавании текста из файла.', details: errorText })
                        };
                    }
                } else {
                    const ocrData = await ocrResponse.json();
                    console.log('Cloudmersive OCR/Convert Raw Response:', JSON.stringify(ocrData).substring(0, Math.min(JSON.stringify(ocrData).length, 200)) + '...');
                    extractedText = ocrData.TextResult || ocrData.TextContent;
                    console.log('Extracted Text (from OCR/Convert):', extractedText.substring(0, Math.min(extractedText.length, 100)) + '...');
                }
            }
        } else if (!fileBuffer && (inputType === 'file' || inputType === 'image')) {
            console.error('Document part is missing for file/image inputType.');
            return { statusCode: 400, body: JSON.stringify({ message: 'Файл документа отсутствует во входных данных.' }) };
        } else if (!extractedText && inputType === 'text') {
            console.error('Text part is missing for text inputType.');
            return { statusCode: 400, body: JSON.stringify({ message: 'Текстовые данные отсутствуют во входных данных.' }) };
        }


        if (!extractedText || extractedText.trim() === '') {
            console.error('Extracted text is empty or null AFTER all processing steps.');
            return {
                statusCode: 400,
                body: JSON.stringify({ message: 'Не удалось распознать текст из документа или текст пуст.' })
            };
        }

        console.log('Text before Google Translate (English target):', extractedText.substring(0, 100) + '...');

        // 2. Перевод текста с Google Translate
        const translateResponse = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_API_KEY}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                q: extractedText,
                source: sourceLanguage === 'auto' ? undefined : sourceLanguage,
                target: 'en'
            })
        });

        if (!translateResponse.ok) {
            const errorData = await translateResponse.json();
            console.error('Google Translate Error:', translateResponse.status, JSON.stringify(errorData));
            return {
                statusCode: translateResponse.status,
                body: JSON.stringify({ message: 'Ошибка при переводе текста.', details: errorData.error ? errorData.error.message : JSON.stringify(errorData) })
            };
        }
        const translateData = await translateResponse.json();
        const translatedTextEnglish = translateData.data.translations[0].translatedText;
        console.log('Translated Text (English):', translatedTextEnglish.substring(0, 100) + '...');


        // 3. Анализ тональности с Hugging Face

        console.log('--- Hugging Face Sentiment Analysis ---');
        console.log('Input text for sentiment analysis:', translatedTextEnglish.substring(0, 100) + '...');
        console.log('Hugging Face API Key:', HUGGING_FACE_API_KEY ? 'Provided' : 'Not Provided'); // Log if key is provided

        const sentimentResponse = await fetch('https://api-inference.huggingface.co/models/cardiffnlp/twitter-xlm-roberta-base-sentiment', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${HUGGING_FACE_API_KEY}`
            },
            body: JSON.stringify({ inputs: translatedTextEnglish })
        });

        console.log('Hugging Face Request Body:', JSON.stringify({ inputs: translatedTextEnglish }).substring(0, 100) + '...'); // Log truncated body

        if (!sentimentResponse.ok) {
            const errorText = await sentimentResponse.text();
            console.error('Hugging Face Sentiment Error:', sentimentResponse.status, errorText);
            return {
                statusCode: sentimentResponse.status,
                body: JSON.stringify({ message: 'Ошибка при анализе тональности текста.', details: errorText })
            };
        }
        const sentimentData = await sentimentResponse.json();
        console.log('Hugging Face Raw Response:', JSON.stringify(sentimentData).substring(0, 500) + '...'); // Log raw response, truncated

        let sentimentAnalysisEnglish = {
            SentimentClassification: "Neutral", // Default to Neutral
            SentimentScore: 0 // Default score
        };

        if (sentimentData && sentimentData.length > 0 && sentimentData[0] && typeof sentimentData[0] === 'object') {
            console.log('Sentiment data structure:', JSON.stringify(sentimentData[0])); // Log structure of the first element
            const sentiments = sentimentData[0];
            if (Array.isArray(sentiments)) {
                console.log('Sentiments array:', JSON.stringify(sentiments)); // Log the array of sentiments
                const topSentiment = sentiments.reduce((prev, current) => {
                    if (typeof current.score === 'number' && current.score > (prev ? prev.score : -Infinity)) {
                        return current;
                    }
                    return prev;
                }, null);

                if (topSentiment && typeof topSentiment.score === 'number') {
                    console.log('Top sentiment found:', JSON.stringify(topSentiment)); // Log the identified top sentiment
                    const labelMap = {
                        "positive": "Positive",
                        "negative": "Negative",
                        "neutral": "Neutral"
                    };
                    const sentimentClassification = labelMap[topSentiment.label.toLowerCase()] || "Neutral";

                    sentimentAnalysisEnglish = {
                        SentimentClassification: sentimentClassification,
                    SentimentScore: (topSentiment && typeof topSentiment.score === 'number') ? topSentiment.score : 0
                };
            } else {
                    console.warn('Could not determine top sentiment from response.');
                }
            } else {
                console.warn('Hugging Face response format is not as expected (sentimentData[0] is not an array).');
            }
        } else {
            console.warn('Hugging Face response is empty or malformed.');
        }
        console.log('Sentiment Analysis (English):', JSON.stringify(sentimentAnalysisEnglish)); // Log final sentiment analysis object

        // 4. Анализ эмоций с Cloudmersive NLP (имитация на основе тональности)
        const emotionsAnalysisEnglish = generateMockEmotions(sentimentAnalysisEnglish.SentimentClassification);
        console.log('Emotions Analysis (English - Mock):', JSON.stringify(emotionsAnalysisEnglish)); // Log mock emotions

        // 5. Перевод результатов обратно на целевой язык (targetLanguage)
        let finalTranslatedText = translatedTextEnglish;
        let finalSentimentLabel = sentimentAnalysisEnglish.SentimentClassification;
        let finalEmotionsAnalysis = emotionsAnalysisEnglish;

        if (targetLanguage !== 'en') {
            const finalTranslateTextResponse = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ q: translatedTextEnglish, target: targetLanguage })
            });
            if (finalTranslateTextResponse.ok) {
                const finalTranslateTextData = await finalTranslateTextResponse.json();
                finalTranslatedText = finalTranslateTextData.data.translations[0].translatedText;
            } else {
                console.warn('Failed to translate final text to target language.');
            }

            const sentimentLabelMap = {
                'Positive': { 'ru': 'Позитивное', 'es': 'Positivo', 'fr': 'Positif', 'de': 'Positiv', 'it': 'Positivo', 'pt': 'Positivo', 'zh': '积极', 'ja': 'ポジティブ', 'ko': '긍정적', 'ar': 'إيجابي' },
                'Negative': { 'ru': 'Негативное', 'es': 'Negativo', 'fr': 'Négatif', 'de': 'Negativ', 'it': 'Negativo', 'pt': 'Negativo', 'zh': '消极', 'ja': 'ネガティブ', 'ko': '부정적', 'ar': 'سلبي' },
                'Neutral': { 'ru': 'Нейтральное', 'es': 'Neutral', 'fr': 'Neutre', 'de': 'Neutral', 'it': 'Neutro', 'pt': 'Neutro', 'zh': '中性', 'ja': '中立', 'ko': '중립적', 'ar': 'محايد' }
            };
            finalSentimentLabel = sentimentLabelMap[sentimentAnalysisEnglish.SentimentClassification]?.[targetLanguage] || sentimentAnalysisEnglish.SentimentClassification;

            const emotionNameMap = {
                'Радость': { 'ru': 'Радость', 'en': 'Joy', 'es': 'Alegría', 'fr': 'Joie', 'de': 'Freude', 'it': 'Gioia', 'pt': 'Alegria', 'zh': '喜悦', 'ja': '喜び', 'ko': '기쁨', 'ar': 'فرح' },
                'Грусть': { 'ru': 'Грусть', 'en': 'Sadness', 'es': 'Tristeza', 'fr': 'Tristesse', 'de': 'Traurigkeit', 'it': 'Tristezza', 'pt': 'Tristeza', 'zh': '悲伤', 'ja': '悲しみ', 'ko': '슬픔', 'ar': 'حزن' },
                'Гнев': { 'ru': 'Гнев', 'en': 'Anger', 'es': 'Ira', 'fr': 'Colère', 'de': 'Wut', 'it': 'Rabbia', 'pt': 'Raiva', 'zh': '愤怒', 'ja': '怒り', 'ko': '분노', 'ar': 'غضب' },
                'Страх': { 'ru': 'Страх', 'en': 'Fear', 'es': 'Miedo', 'fr': 'Peur', 'de': 'Angst', 'it': 'Paura', 'pt': 'Medo', 'zh': '恐惧', 'ja': '恐怖', 'ko': '두려움', 'ar': 'خوف' },
                'Удивление': { 'ru': 'Удивление', 'en': 'Surprise', 'es': 'Sorpresa', 'fr': 'Surprise', 'de': 'Überraschung', 'it': 'Sorpresa', 'pt': 'Surpresa', 'zh': '惊讶', 'ja': '驚き', 'ko': '놀람', 'ar': 'دهشة' },
                'Отвращение': { 'ru': 'Отвращение', 'en': 'Disgust', 'es': 'Asco', 'fr': 'Dégoût', 'de': 'Ekel', 'it': 'Disgusto', 'pt': 'Nojo', 'zh': '厌恶', 'ja': '嫌悪', 'ko': '혐오', 'ar': 'اشمئزاز' }
            };

            finalEmotionsAnalysis = emotionsAnalysisEnglish.map(emotion => ({
                ...emotion,
                name: emotionNameMap[emotion.name]?.[targetLanguage] || emotion.name
            }));
        }

        console.log('Final Translated Text:', finalTranslatedText.substring(0, 100) + '...');
        console.log('Final Sentiment Label:', finalSentimentLabel);
        console.log('Final Emotions Analysis:', JSON.stringify(finalEmotionsAnalysis)); // Log final emotions analysis
        console.log('--- Netlify Function End ---');

        return {
            statusCode: 200,
            body: JSON.stringify({
                extractedText: extractedText,
                translatedText: finalTranslatedText,
                sentimentAnalysis: {
                    ...sentimentAnalysisEnglish,
                    SentimentClassification: finalSentimentLabel
                },
                emotionsAnalysis: finalEmotionsAnalysis
            })
        };

    } catch (error) {
        console.error('Serverless function error:', error);
        console.error('Error details:', error.stack);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: 'Внутренняя ошибка сервера.', details: error.message })
        };
    }
};

// Вспомогательная функция для генерации имитации эмоций на основе тональности
function generateMockEmotions(sentimentLabel) {
    const baseEmotions = [
        { name: 'Радость', emoji: '😊', score: 0 },
        { name: 'Грусть', emoji: '😢', score: 0 },
        { name: 'Гнев', emoji: '😠', score: 0 },
        { name: 'Страх', emoji: '😨', score: 0 },
        { name: 'Удивление', emoji: '😲', score: 0 },
        { name: 'Отвращение', emoji: '🤢', score: 0 }
    ];

    switch (sentimentLabel) {
        case 'Positive':
            baseEmotions[0].score = Math.random() * 0.4 + 0.6; // Радость
            baseEmotions[4].score = Math.random() * 0.3 + 0.2; // Удивление
            break;
        case 'Negative':
            baseEmotions[1].score = Math.random() * 0.4 + 0.6; // Грусть
            baseEmotions[2].score = Math.random() * 0.3 + 0.2; // Гнев
            baseEmotions[3].score = Math.random() * 0.2 + 0.1; // Страх
            baseEmotions[5].score = Math.random() * 0.2 + 0.1; // Отвращение
            break;
        case 'Neutral':
            baseEmotions[0].score = Math.random() * 0.3;
            baseEmotions[1].score = Math.random() * 0.3;
            baseEmotions[4].score = Math.random() * 0.4 + 0.1; // Небольшое удивление
            break;
    }

    // Добавляем немного случайности ко всем
    baseEmotions.forEach(e => e.score = Math.min(1, e.score + (Math.random() * 0.1 - 0.05)));

    return baseEmotions.sort((a, b) => b.score - a.score);
}
