const fetch = require('node-fetch').default;

async function checkCloudmersiveKey(apiKey) {
    if (!apiKey) {
        console.error('Ошибка: Ключ Cloudmersive API не предоставлен.');
        return;
    }

    const testText = 'This is a test sentence.';

    try {
        console.log('Проверка ключа Cloudmersive API...');
        console.log(`Отправка запроса на анализ тональности текста: "${testText}"`);

        const response = await fetch('https://api.cloudmersive.com/nlp-v2/analytics/sentiment', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Apikey': apiKey
            },
            body: JSON.stringify({ TextToAnalyze: testText })
        });

        const responseText = await response.text(); // Получаем ответ как текст

        if (response.ok) {
            console.log('------------------------------------');
            console.log('Ключ Cloudmersive API действителен!');
            // Попытаемся распарсить JSON, если ответ действительно JSON
            try {
                const data = JSON.parse(responseText);
                console.log('Результат анализа тональности:', data);
            } catch (parseError) {
                console.error('------------------------------------');
                console.error('Ключ действителен, но ответ не является корректным JSON.');
                console.error('Полученный ответ:', responseText);
                console.error('------------------------------------');
            }
            console.log('------------------------------------');
        } else {
            console.error('------------------------------------');
            console.error('Ошибка при проверке ключа Cloudmersive API.');
            console.error(`Статус: ${response.status}`);
            console.error('Сообщение об ошибке:', responseText); // Выводим полный текст ответа
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
checkCloudmersiveKey(apiKey);
