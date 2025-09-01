const fetch = require('node-fetch').default;

async function checkGoogleTranslateKey(apiKey) {
    if (!apiKey) {
        console.error('Ошибка: Ключ Google Translate API не предоставлен.');
        return;
    }

    const testText = 'Hello';
    const targetLanguage = 'ru';

    try {
        console.log(`Проверка ключа Google Translate API...`);
        console.log(`Отправка запроса на перевод текста: "${testText}" на язык: "${targetLanguage}"`);

        const response = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${apiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                q: testText,
                target: targetLanguage
            })
        });

        const data = await response.json();

        if (response.ok) {
            if (data.data && data.data.translations && data.data.translations.length > 0) {
                console.log('------------------------------------');
                console.log('Ключ Google Translate API действителен!');
                console.log(`Переведенный текст: "${data.data.translations[0].translatedText}"`);
                console.log('------------------------------------');
            } else {
                console.error('------------------------------------');
                console.error('Ключ Google Translate API может быть действителен, но ответ API не содержит ожидаемых данных перевода.');
                console.error('Ответ API:', JSON.stringify(data, null, 2));
                console.error('------------------------------------');
            }
        } else {
            console.error('------------------------------------');
            console.error('Ошибка при проверке ключа Google Translate API.');
            console.error(`Статус: ${response.status}`);
            console.error('Сообщение об ошибке:', data.error ? data.error.message : JSON.stringify(data));
            console.error('------------------------------------');
        }
    } catch (error) {
        console.error('------------------------------------');
        console.error('Произошла сетевая ошибка или другая непредвиденная ошибка:', error.message);
        console.error('------------------------------------');
    }
}

// Получаем ключ API из аргументов командной строки
const apiKey = process.argv[2];
checkGoogleTranslateKey(apiKey);
