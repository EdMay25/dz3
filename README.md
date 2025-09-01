# Проект Анализа Текста и Эмоций

Этот проект представляет собой бессерверное приложение, которое использует Netlify Functions для анализа текста, извлеченного из различных источников (текст, изображения, PDF, DOCX), перевода его на английский язык, выполнения анализа тональности и эмоций с помощью Cloudmersive NLP, а затем перевода результатов обратно на целевой язык.

## Содержание

- [Проект Анализа Текста и Эмоций](#проект-анализа-текста-и-эмоций)
  - [Содержание](#содержание)
  - [Установка](#установка)
  - [Переменные среды](#переменные-среды)
  - [Локальная разработка](#локальная-разработка)
  - [Развертывание на Netlify](#развертывание-на-netlify)
  - [Memory Bank (Банк Памяти)](#memory-bank-банк-памяти)
    - [Пошаговые инструкции по созданию Memory Bank с MongoDB Atlas:](#пошаговые-инструкции-по-созданию-memory-bank-с-mongodb-atlas)
  - [Лицензия](#лицензия)

## Установка

Для запуска проекта локально выполните следующие шаги:

1.  **Клонируйте репозиторий:**
    ```bash
    git clone https://github.com/EdMay25/dz3.git
    cd dz3
    ```

2.  **Установите зависимости для корневого проекта (если есть):**
    ```bash
    npm install
    ```
    (В данном проекте корневые зависимости могут отсутствовать, но это хорошая практика.)

3.  **Установите зависимости для Netlify Function:**
    ```bash
    cd netlify/functions
    npm install
    cd ../..
    ```

## Переменные среды

Для работы приложения требуются API-ключи для Cloudmersive и Google Translate.

1.  **Создайте файл `.env`:**
    В корневом каталоге проекта создайте файл с именем `.env`. Этот файл будет использоваться для локальной разработки и не будет загружен в ваш репозиторий GitHub (он уже добавлен в `.gitignore`).

2.  **Добавьте ваши API-ключи:**
    Откройте файл `.env` и добавьте следующие строки, заменив `your_cloudmersive_api_key` и `your_google_translate_api_key` на ваши фактические ключи:

    ```
    CLOUDMERSIVE_API_KEY=your_cloudmersive_api_key
    GOOGLE_TRANSLATE_API_KEY=your_google_translate_api_key
    ```

    *   **Cloudmersive API Key:** Вы можете получить его, зарегистрировавшись на [Cloudmersive](https://cloudmersive.com/).
    *   **Google Translate API Key:** Вы можете получить его через [Google Cloud Console](https://console.cloud.google.com/apis/credentials).

## Локальная разработка

Для локального тестирования Netlify Functions вам понадобится Netlify CLI.

1.  **Установите Netlify CLI:**
    ```bash
    npm install netlify-cli -g
    ```

2.  **Запустите локальный сервер Netlify:**
    В корневом каталоге проекта выполните:
    ```bash
    netlify dev
    ```
    Это запустит локальный сервер, который будет эмулировать среду Netlify, включая ваши функции. Ваше приложение будет доступно по адресу `http://localhost:8888`.

## Развертывание на Netlify

1.  **Создайте репозиторий GitHub:**
    Убедитесь, что ваш проект находится в репозитории GitHub.

2.  **Подключите Netlify к GitHub:**
    *   Войдите в свою учетную запись Netlify.
    *   Нажмите "Add new site" -> "Import an existing project".
    *   Выберите "Deploy with GitHub" и авторизуйте Netlify для доступа к вашим репозиториям.
    *   Выберите репозиторий `dz3`.

3.  **Настройте параметры сборки:**
    *   **Base directory:** (Оставьте пустым, если `index.html` находится в корне)
    *   **Build command:** `npm install && cd netlify/functions && npm install && cd ../..` (или просто `npm install` если все зависимости в корне)
    *   **Publish directory:** `.` (или `public`, если у вас есть папка `public`)

4.  **Настройте переменные среды в Netlify:**
    *   После создания сайта перейдите в "Site settings" -> "Build & deploy" -> "Environment variables".
    *   Добавьте `CLOUDMERSIVE_API_KEY` и `GOOGLE_TRANSLATE_API_KEY` со значениями ваших реальных API-ключей. Эти ключи будут доступны вашим Netlify Functions во время развертывания.

5.  **Разверните сайт:**
    Netlify автоматически развернет ваш сайт при каждом пуше в ветку, которую вы настроили для развертывания (обычно `main` или `master`).

## Memory Bank (Банк Памяти)

Для хранения небольших структурированных данных, таких как настройки пользователя или история запросов, мы рекомендуем использовать внешнюю базу данных. В этом примере мы будем использовать **MongoDB Atlas**.

### Пошаговые инструкции по созданию Memory Bank с MongoDB Atlas:

1.  **Создайте учетную запись MongoDB Atlas:**
    *   Перейдите на [MongoDB Atlas](https://www.mongodb.com/cloud/atlas/register) и зарегистрируйтесь.
    *   Выберите бесплатный "Shared Cluster" (M0 Sandbox).
    *   Следуйте инструкциям для создания нового кластера. Выберите ближайший к вам регион.

2.  **Настройте доступ к сети:**
    *   В разделе "Network Access" добавьте текущий IP-адрес (для локальной разработки) и `0.0.0.0/0` (для доступа из Netlify Functions). Будьте осторожны с `0.0.0.0/0` в продакшене и рассмотрите более строгие правила безопасности.

3.  **Создайте пользователя базы данных:**
    *   В разделе "Database Access" создайте нового пользователя базы данных с надежным паролем. Запомните имя пользователя и пароль.

4.  **Получите строку подключения:**
    *   После создания кластера нажмите "Connect".
    *   Выберите "Connect your application".
    *   Скопируйте строку подключения. Она будет выглядеть примерно так:
        `mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`
    *   Замените `<username>` и `<password>` на учетные данные пользователя базы данных, созданного на предыдущем шаге.

5.  **Добавьте строку подключения в переменные среды:**
    *   **Локально:** Добавьте следующую строку в ваш файл `.env` в корне проекта:
        ```
        MONGODB_URI=ваша_строка_подключения_mongodb
        ```
    *   **На Netlify:** Добавьте `MONGODB_URI` как переменную среды в настройках вашего сайта Netlify (Site settings -> Build & deploy -> Environment variables), используя вашу строку подключения.

6.  **Установите драйвер MongoDB в Netlify Function:**
    *   Перейдите в каталог `netlify/functions`:
        ```bash
        cd netlify/functions
        npm install mongodb
        cd ../..
        ```

7.  **Пример использования в `netlify/functions/analyze.js`:**
    Вы можете добавить код для подключения к MongoDB и сохранения/извлечения данных. Например, для сохранения истории анализа:

    ```javascript
    const { MongoClient } = require('mongodb');

    // ... (существующий код)

    exports.handler = async (event, context) => {
        // ... (существующий код)

        const MONGODB_URI = process.env.MONGODB_URI;
        let client;

        try {
            // Подключение к MongoDB
            client = new MongoClient(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
            await client.connect();
            const database = client.db('your_database_name'); // Замените на имя вашей базы данных
            const collection = database.collection('analysis_history'); // Замените на имя вашей коллекции

            // Пример сохранения данных
            const analysisResult = {
                timestamp: new Date(),
                extractedText: extractedText,
                translatedText: finalTranslatedText,
                sentiment: finalSentimentLabel,
                emotions: finalEmotionsAnalysis
            };
            await collection.insertOne(analysisResult);
            console.log('Analysis result saved to MongoDB.');

            // ... (остальной код функции)

        } catch (error) {
            console.error('Serverless function error:', error);
            console.error('Error details:', error.stack);
            return {
                statusCode: 500,
                body: JSON.stringify({ message: 'Внутренняя ошибка сервера.', details: error.message })
            };
        } finally {
            if (client) {
                await client.close();
            }
        }
    };
    ```
    **Важно:** Убедитесь, что вы заменили `your_database_name` и `analysis_history` на желаемые имена базы данных и коллекции.

## Лицензия

[Укажите здесь вашу лицензию, например, MIT License]
