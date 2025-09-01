const fetch = require('node-fetch');
const Busboy = require('busboy');
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
                        'Apikey': CLOUDMERSIVE_API_KEY,
                        ...formData.getHeaders()
                    },
                    body: formData
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
