# TRANSLAT KHMER NEW PRO

កម្មវិធីថ្មីដាច់ដោយឡែក សម្រាប់បកប្រែអត្ថបទ និងវីដេអូទៅជាភាសាខ្មែរ។ រូបរាងកម្មវិធីត្រូវបានរក្សាដដែល ហើយ Backend ថ្មីស្ថិតនៅក្នុង repository នេះ។

## Frontend
- Vite + Capacitor Android
- App ID: `com.translatkhmer.newpro`
- UI: `index.html`
- Backend URL ត្រូវបញ្ចូលនៅក្នុងកម្មវិធី បន្ទាប់ពី Deploy service ថ្មីរួច។

## Backend ថ្មី
- Source: `backend/server.js`
- Render Blueprint: `render.yaml`
- Health check: `/health`
- Video transcription/translation: `POST /api/video/translate`
- Gemini API Key ត្រូវដាក់ជា Render Environment Variable `GEMINI_API_KEY`។ កុំដាក់ Key ក្នុង Frontend ឬ GitHub។

## Deploy Backend
1. នៅ Render ជ្រើសរើស New + Blueprint ហើយភ្ជាប់ repository នេះ។
2. Render អាន `render.yaml` ហើយបង្កើត service `translat-khmer-new-pro-api`។
3. បញ្ចូល `GEMINI_API_KEY` ថ្មីនៅ Environment របស់ service។
4. Deploy រួចបើក `/health` ដើម្បីពិនិត្យថា service ដំណើរការ។
5. ចម្លង URL របស់ service ថ្មី ហើយបញ្ចូលក្នុងកម្មវិធីត្រង់ Backend URL រួចចុច រក្សាទុក។

## ស្ថានភាពមុខងារ
- បកប្រែអត្ថបទ: ប្រើសេវាបកប្រែតាមអ៊ីនធឺណិតពី Frontend។
- ស្គាល់សំឡេងវីដេអូ និងបង្កើត Subtitle ខ្មែរ: Backend Gemini endpoint បានរៀបចំ។
- បង្កើតសំឡេងខ្មែរ និងបញ្ចូលចូល MP4: មិនទាន់បានបញ្ចប់។ Endpoint `/api/dub` ឆ្លើយតបថាមិនទាន់គាំទ្រ ដើម្បីមិនបង្ហាញលទ្ធផលក្លែងក្លាយ។

កម្មវិធីនេះមិនគួរភ្ជាប់ទៅ Backend របស់គម្រោងចាស់ទេ។
