const Busboy = require('busboy');
const { Buffer } = require('buffer');
const { ImageAnnotatorClient } = require('@google-cloud/vision');
const { Storage } = require('@google-cloud/storage');

// Динамический импорт node-fetch для совместимости с ES-модулями в CommonJS
let fetch;
const init = async () => {
    if (!fetch) {
        const nodeFetch = await import('node-fetch');
        fetch = nodeFetch.default;
    }
};

// Инициализация клиентов Google Cloud Vision и Storage
const visionClient = new ImageAnnotatorClient();
const storageClient = new Storage();

exports.handler = async (event, context) => {
    await init(); // Инициализируем fetch перед выполнением логики функции
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;
    const HUGGING_FACE_API_KEY = process.env.HUGGING_FACE_API_KEY;
    const GOOGLE_CLOUD_PROJECT_ID = process.env.GOOGLE_CLOUD_PROJECT_ID; // Для Google Cloud Storage

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

            busboy.on('file', (fieldname, file, fileInfo) => {
                console.log(`File [${fieldname}]: filename=${fileInfo.filename}, mimetype=${fileInfo.mimeType}`);
                const chunks = [];
                file.on('data', data => chunks.push(data));
                file.on('end', () => {
                    fileBuffer = Buffer.concat(chunks);
                    fileName = fileInfo.filename;
                    fileMimeType = fileInfo.mimeType;
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
        console.log('DEBUG: fileBuffer exists:', !!fileBuffer);

        if ((inputType === 'file' || inputType === 'image') && fileBuffer) {
            console.log('DEBUG: Entering file/image processing block with Google Cloud Vision.');

            if (fileMimeType && fileMimeType.startsWith('image/')) {
                const [result] = await visionClient.documentTextDetection({
                    image: { content: fileBuffer.toString('base64') },
                });
                const detections = result.fullTextAnnotation;
                extractedText = detections ? detections.text : '';
                console.log('Extracted Text (from Google Vision Image OCR):', extractedText.substring(0, Math.min(extractedText.length, 100)) + '...');
            } else if (fileMimeType === 'application/pdf') {
                // Для PDF требуется загрузка в Google Cloud Storage
                if (!GOOGLE_CLOUD_PROJECT_ID) {
                    console.error('GOOGLE_CLOUD_PROJECT_ID is not set for PDF OCR.');
                    return { statusCode: 500, body: JSON.stringify({ message: 'Не настроен GOOGLE_CLOUD_PROJECT_ID для OCR PDF.' }) };
                }
                const bucketName = `${GOOGLE_CLOUD_PROJECT_ID}-ocr-temp`; // Имя бакета для временных файлов
                const filePath = `temp-ocr/${Date.now()}-${fileName}`;
                const file = storageClient.bucket(bucketName).file(filePath);

                await file.save(fileBuffer, {
                    metadata: { contentType: fileMimeType }
                });
                console.log(`File ${filePath} uploaded to ${bucketName}.`);

                const gcsSourceUri = `gs://${bucketName}/${filePath}`;
                const gcsDestinationUri = `gs://${bucketName}/results/${Date.now()}-output.json`;

                const [operation] = await visionClient.asyncBatchAnnotateFiles({
                    requests: [
                        {
                            inputConfig: {
                                gcsSource: { uri: gcsSourceUri },
                                mimeType: 'application/pdf',
                            },
                            features: [{ type: 'DOCUMENT_TEXT_DETECTION' }],
                            outputConfig: {
                                gcsDestination: { uri: gcsDestinationUri },
                                batchSize: 2, // Количество страниц для обработки в одном запросе
                            },
                        },
                    ],
                });

                const [filesResponse] = await operation.promise();
                const destinationUri = filesResponse.responses[0].outputConfig.gcsDestination.uri;
                console.log('OCR results saved to:', destinationUri);

                // Чтение результатов из GCS
                const match = destinationUri.match(/gs:\/\/([a-z0-9\._-]+)\/(.*)/i);
                if (!match) {
                    console.error('Invalid GCS destination URI:', destinationUri);
                    return { statusCode: 500, body: JSON.stringify({ message: 'Ошибка при получении URI результатов OCR.' }) };
                }
                const outputBucketName = match[1];
                const outputPrefix = match[2];

                const [files] = await storageClient.bucket(outputBucketName).getFiles({ prefix: outputPrefix });
                let fullText = '';
                for (const file of files) {
                    const contents = await file.download();
                    const json = JSON.parse(contents.toString());
                    for (const response of json.responses) {
                        fullText += response.fullTextAnnotation.text;
                    }
                }
                extractedText = fullText;
                console.log('Extracted Text (from Google Vision PDF OCR):', extractedText.substring(0, Math.min(extractedText.length, 100)) + '...');

                // Удаление временных файлов
                await storageClient.bucket(bucketName).file(filePath).delete();
                for (const file of files) {
                    await file.delete();
                }
                console.log('Temporary files deleted from GCS.');

            } else if (fileMimeType === 'text/plain') {
                extractedText = fileBuffer.toString('utf8');
                console.log('Extracted Text (from text/plain file):', extractedText.substring(0, Math.min(extractedText.length, 100)) + '...');
            } else {
                console.error('Unsupported file type for OCR/conversion:', fileMimeType);
                return { statusCode: 400, body: JSON.stringify({ message: 'Неподдерживаемый тип файла для OCR/конвертации.' }) };
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

        console.log('Text before Google Translate (English target):', extractedText.substring(0, Math.min(extractedText.length, 100)) + '...');
        console.log('DEBUG: Extracted text length before Google Translate:', extractedText.length); // Добавлено логирование

        // 2. Перевод текста с Google Translate
        console.log('Starting Google Translate API call...');
        console.log('Google Translate API Key available:', !!GOOGLE_TRANSLATE_API_KEY);
        console.log('Text to translate (first 100 chars):', extractedText.substring(0, Math.min(extractedText.length, 100)) + '...');
        console.log('DEBUG: Source Language for Google Translate:', sourceLanguage); // Добавлено логирование
        console.log('DEBUG: Target Language for Google Translate (first pass): en'); // Добавлено логирование

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

            // Улучшенная обработка ошибок перевода
            let errorMessage = 'Ошибка при переводе текста.';
            if (errorData.error && errorData.error.message) {
                errorMessage += ` Детали: ${errorData.error.message}`;

                // Если ошибка связана с API ключом
                if (errorData.error.message.includes('API key') ||
                    errorData.error.message.includes('invalid') ||
                    errorData.error.message.includes('authentication')) {
                    errorMessage += '. Проверьте наличие и корректность GOOGLE_TRANSLATE_API_KEY.';
                    console.error('Google Translate API Key Issue:', errorData.error.message);
                }
            }

            // Возвращаем оригинальный текст, если перевод не удался
            return {
                statusCode: 200, // Возвращаем 200, чтобы клиент получил ответ
                body: JSON.stringify({
                    extractedText: extractedText,
                    translatedText: "Текст не был переведен. " + errorMessage,
                    sentimentAnalysis: {
                        SentimentClassification: "Neutral",
                        SentimentScore: 0
                    },
                    emotionsAnalysis: []
                })
            };
        }

                const translateData = await translateResponse.json();
                const translatedTextEnglish = translateData.data.translations[0].translatedText;
                console.log('Translated Text (English):', translatedTextEnglish.substring(0, 100) + '...');

                // Проверка на пустой переведенный текст
                if (!translatedTextEnglish || translatedTextEnglish.trim() === '') {
                    console.error('WARNING: Google Translate returned empty text!');
                    return {
                        statusCode: 200,
                        body: JSON.stringify({
                            extractedText: extractedText,
                            translatedText: "Текст не был переведен. Возникла ошибка при переводе.",
                            sentimentAnalysis: {
                                SentimentClassification: "Neutral",
                                SentimentScore: 0
                            },
                            emotionsAnalysis: []
                        })
                    };
                }


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

        console.log('Hugging Face Request Body:', JSON.stringify({ inputs: translatedTextEnglish }).substring(0, Math.min(JSON.stringify({ inputs: translatedTextEnglish }).length, 100)) + '...'); // Log truncated body
        console.log('DEBUG: Translated text length for Hugging Face:', translatedTextEnglish.length); // Добавлено логирование

        if (!sentimentResponse.ok) {
            const errorText = await sentimentResponse.text();
            console.error('Hugging Face Sentiment Error:', sentimentResponse.status, errorText);
            console.error('Hugging Face Sentiment Full Error Response:', errorText); // Добавлено логирование полного ответа
            return {
                statusCode: sentimentResponse.status,
                body: JSON.stringify({ message: 'Ошибка при анализе тональности текста.', details: errorText })
            };
        }
        const sentimentData = await sentimentResponse.json();
        console.log('Hugging Face Raw Response:', JSON.stringify(sentimentData).substring(0, Math.min(JSON.stringify(sentimentData).length, 500)) + '...'); // Log raw response, truncated
        console.log('DEBUG: Hugging Face response type:', typeof sentimentData); // Добавлено логирование
        console.log('DEBUG: Hugging Face response is array:', Array.isArray(sentimentData)); // Добавлено логирование

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
            console.log('DEBUG: Starting final Google Translate API call (back to target language)...'); // Добавлено логирование
            console.log('DEBUG: Text to translate back (first 100 chars):', translatedTextEnglish.substring(0, Math.min(translatedTextEnglish.length, 100)) + '...'); // Добавлено логирование
            console.log('DEBUG: Target Language for final Google Translate:', targetLanguage); // Добавлено логирование

            const finalTranslateTextResponse = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_API_KEY}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ q: translatedTextEnglish, target: targetLanguage })
            });
            if (finalTranslateTextResponse.ok) {
                const finalTranslateTextData = await finalTranslateTextResponse.json();
                finalTranslatedText = finalTranslateTextData.data.translations[0].translatedText;
                console.log('DEBUG: Final translated text (first 100 chars):', finalTranslatedText.substring(0, Math.min(finalTranslatedText.length, 100)) + '...'); // Добавлено логирование
            } else {
                const errorText = await finalTranslateTextResponse.text(); // Добавлено логирование ошибки
                console.warn('Failed to translate final text to target language:', errorText); // Обновлено логирование
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

            finalEmotionsAnalysis = emotionsAnalysisEnglish.map(emotion => {
                const translatedName = emotionNameMap[emotion.name] && emotionNameMap[emotion.name][targetLanguage] ? emotionNameMap[emotion.name][targetLanguage] : emotion.name;
                return {
                    ...emotion,
                    name: translatedName
                };
            });
        }

        console.log('Final Translated Text:', finalTranslatedText.substring(0, 100) + '...');
        console.log('Final Sentiment Label:', finalSentimentLabel);
        console.log('Final Emotions Analysis:', JSON.stringify(finalEmotionsAnalysis)); // Log final emotions analysis

        // Дополнительное логирование для проверки переведенного текста
        console.log('DEBUG: Translated Text Length:', finalTranslatedText.length);
        console.log('DEBUG: Translated Text (First 200 chars):', finalTranslatedText.substring(0, 200));

        // Проверка, что переведенный текст не пустой
        if (!finalTranslatedText || finalTranslatedText.trim() === '') {
            console.error('Final translated text is empty or null.');
            finalTranslatedText = "Текст не был переведен. Возникла ошибка.";
        }

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
