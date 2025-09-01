const fetch = require('node-fetch');
const FormData = require('form-data');
const { Buffer } = require('buffer');

exports.handler = async (event, context) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const CLOUDMERSIVE_API_KEY = process.env.CLOUDMERSIVE_API_KEY;
    const GOOGLE_TRANSLATE_API_KEY = process.env.GOOGLE_TRANSLATE_API_KEY;

    try {
        let extractedText = '';
        let sourceLanguage = 'auto';
        let targetLanguage = 'ru';
        let inputType = '';

        console.log('--- Netlify Function Start ---');
        console.log('Event HTTP Method:', event.httpMethod);
        console.log('Event Headers:', event.headers);
        console.log('Event isBase64Encoded:', event.isBase64Encoded);

        const contentType = event.headers['content-type'];
        let requestBody = event.body;

        if (event.isBase64Encoded) {
            requestBody = Buffer.from(requestBody, 'base64').toString('binary');
        }

        if (contentType && contentType.includes('multipart/form-data')) {
            const boundary = contentType.split('; ')[1].split('=')[1];
            const parts = parseMultipartForm(requestBody, boundary);

            const textPart = parts.find(p => p.name === 'text');
            const documentPart = parts.find(p => p.name === 'document');
            const sourceLangPart = parts.find(p => p.name === 'sourceLanguage');
            const targetLangPart = parts.find(p => p.name === 'targetLanguage');
            const inputTypePart = parts.find(p => p.name === 'inputType');

            if (sourceLangPart) sourceLanguage = sourceLangPart.data;
            if (targetLangPart) targetLanguage = targetLangPart.data;
            if (inputTypePart) inputType = inputTypePart.data;

            console.log('Parsed inputType:', inputType);
            console.log('Parsed sourceLanguage:', sourceLanguage);
            console.log('Parsed targetLanguage:', targetLanguage);
            console.log('Text part present:', !!textPart);
            console.log('Document part present:', !!documentPart);

            if (inputType === 'text' && textPart) {
                extractedText = textPart.data;
                console.log('Extracted Text (from text input):', extractedText.substring(0, Math.min(extractedText.length, 100)) + '...');
            } else if ((inputType === 'file' || inputType === 'image') && documentPart) {
                const fileBuffer = Buffer.from(documentPart.data, 'binary');
                const fileName = documentPart.filename || 'document';
                const fileMimeType = documentPart['Content-Type'] || 'application/octet-stream';
                console.log('File Name:', fileName);
                console.log('File MIME Type:', fileMimeType);

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
                    const ocrFormData = new FormData();
                    ocrFormData.append('inputFile', fileBuffer, {
                        filename: fileName,
                        contentType: fileMimeType
                    });

                    const ocrResponse = await fetch(ocrEndpoint, {
                        method: 'POST',
                        headers: {
                            'Apikey': CLOUDMERSIVE_API_KEY,
                            ...ocrFormData.getHeaders()
                        },
                        body: ocrFormData
                    });

                    if (!ocrResponse.ok) {
                        const errorText = await ocrResponse.text();
                        console.error('Cloudmersive OCR/Convert Error:', ocrResponse.status, errorText);
                        return {
                            statusCode: ocrResponse.status,
                            body: JSON.stringify({ message: 'Ошибка при распознавании текста из файла.', details: errorText })
                        };
                    }
                    const ocrData = await ocrResponse.json();
                    console.log('Cloudmersive OCR/Convert Raw Response:', JSON.stringify(ocrData).substring(0, Math.min(JSON.stringify(ocrData).length, 200)) + '...');
                    extractedText = ocrData.TextResult || ocrData.TextContent;
                    console.log('Extracted Text (from OCR/Convert):', extractedText.substring(0, Math.min(extractedText.length, 100)) + '...');
                }
            } else if (!documentPart && (inputType === 'file' || inputType === 'image')) {
                console.error('Document part is missing for file/image inputType.');
                return { statusCode: 400, body: JSON.stringify({ message: 'Файл документа отсутствует во входных данных.' }) };
            } else if (!textPart && inputType === 'text') {
                console.error('Text part is missing for text inputType.');
                return { statusCode: 400, body: JSON.stringify({ message: 'Текстовые данные отсутствуют во входных данных.' }) };
            }
        } else {
            console.error('Invalid Content-Type. Expected multipart/form-data.');
            return { statusCode: 400, body: 'Invalid Content-Type. Expected multipart/form-data.' };
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
            console.error('Google Translate Error:', translateResponse.status, errorData);
            return {
                statusCode: translateResponse.status,
                body: JSON.stringify({ message: 'Ошибка при переводе текста.', details: errorData })
            };
        }
        const translateData = await translateResponse.json();
        const translatedTextEnglish = translateData.data.translations[0].translatedText;
        console.log('Translated Text (English):', translatedTextEnglish.substring(0, 100) + '...');

        // 3. Анализ тональности с Cloudmersive NLP
        const sentimentResponse = await fetch('https://api.cloudmersive.com/nlp/analytics/sentiment/getSentiment', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Apikey': CLOUDMERSIVE_API_KEY
            },
            body: JSON.stringify({ Text: translatedTextEnglish })
        });

        if (!sentimentResponse.ok) {
            const errorText = await sentimentResponse.text();
            console.error('Cloudmersive NLP Sentiment Error:', sentimentResponse.status, errorText);
            return {
                statusCode: sentimentResponse.status,
                body: JSON.stringify({ message: 'Ошибка при анализе тональности текста.', details: errorText })
            };
        }
        const sentimentAnalysisEnglish = await sentimentResponse.json();
        console.log('Sentiment Analysis (English):', sentimentAnalysisEnglish);

        // 4. Анализ эмоций с Cloudmersive NLP (имитация на основе тональности)
        const emotionsAnalysisEnglish = generateMockEmotions(sentimentAnalysisEnglish.SentimentClassification);
        console.log('Emotions Analysis (English - Mock):', emotionsAnalysisEnglish);

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
        console.log('Final Emotions Analysis:', finalEmotionsAnalysis);
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

// Вспомогательная функция для парсинга multipart/form-data
function parseMultipartForm(body, boundary) {
    const parts = [];
    const lines = body.split(new RegExp(`--${boundary}(?:--)?\r?\n`));

    for (const line of lines) {
        if (!line.trim()) continue;

        const headerEnd = line.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;

        const headersRaw = line.substring(0, headerEnd);
        const data = line.substring(headerEnd + 4);

        const part = {};
        headersRaw.split('\r\n').forEach(headerLine => {
            const headerParts = headerLine.split(': ');
            const key = headerParts.shift(); // Извлекаем первый элемент как ключ
            const value = headerParts.join(': '); // Остальное - значение (может содержать двоеточия)

            if (key && value) {
                const lowerKey = key.toLowerCase();
                if (lowerKey === 'content-disposition') {
                    value.split('; ').forEach(dispositionPart => {
                        const dispositionKeyValue = dispositionPart.split('=');
                        if (dispositionKeyValue.length === 2) {
                            const dispositionKey = dispositionKeyValue[0].trim();
                            const dispositionValue = dispositionKeyValue[1].replace(/"/g, '');
                            part[dispositionKey] = dispositionValue;
                        }
                    });
                } else {
                    part[key.trim()] = value.trim();
                }
            }
        });
        part.data = data;
        parts.push(part);
    }
    return parts;
}

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
