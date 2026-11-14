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
- ស្គាល់សំឡេងវីដេអូ និងបង្កើត Subtitle ខ្មែរ: Backend Gemini endpoint។
- បង្កើតសំឡេងខ្មែរ និងបញ្ចូលចូល MP4: មាន pipeline ថ្មីតាម Gemini 3.8 Flash TTS និង FFmpeg។ Backend បង្កើត Job ID, ផ្ដល់ភាគរយតាមស្ថានភាពការងារ និងអនុញ្ញាតទាញយក MP4 ពេលរួចរាល់។
- ត្រូវដាក់ `GEMINI_API_KEY` នៅ Render Environment។ អាចកំណត់ `GEMINI_TTS_MODEL` និង `GEMINI_TTS_VOICE` តាម Environment ផងដែរ។
- ការងារ Dubbing រក្សាទុកជាបណ្ដោះអាសន្នលើ instance ហើយឯកសារលទ្ធផលផុតកំណត់ក្រោយ 30 នាទី។ សូមទាញយកភ្លាមៗពេលបង្ហាញថារួចរាល់។
- ការធ្វើតេស្តវីដេអូពិតនៅ Render និងការផ្ទៀងផ្ទាត់សំឡេងខ្មែរ ត្រូវធ្វើបន្ទាប់ពី Deploy branch ដែលបានកែរួច។
កម្មវិធីនេះមិនគួរភ្ជាប់ទៅ Backend របស់គម្រោងចាស់ទេ។
