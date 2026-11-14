import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";

const jobs = new Map();
const MODEL = process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts";
const VOICE = process.env.GEMINI_TTS_VOICE || "Kore";
const MAX_SEGMENTS = 80;
const JOB_TTL_MS = 30 * 60 * 1000;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(stderr) : reject(new Error((stderr || command + " failed").slice(-1800))));
  });
}
function makeWav(pcm, sampleRate = 24000, channels = 1) {
  const h = Buffer.alloc(44);
  h.write("RIFF",0); h.writeUInt32LE(36+pcm.length,4); h.write("WAVE",8); h.write("fmt ",12);
  h.writeUInt32LE(16,16); h.writeUInt16LE(1,20); h.writeUInt16LE(channels,22);
  h.writeUInt32LE(sampleRate,24); h.writeUInt32LE(sampleRate*channels*2,28);
  h.writeUInt16LE(channels*2,32); h.writeUInt16LE(16,34); h.write("data",36); h.writeUInt32LE(pcm.length,40);
  return Buffer.concat([h,pcm]);
}
async function makeSpeech(text, apiKey, outputPath) {
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/interactions", {
    method:"POST", headers:{"x-goog-api-key":apiKey,"Content-Type":"application/json"},
    body:JSON.stringify({
      model:MODEL,
      input:"Speak the following Khmer text clearly and naturally in Khmer language. Do not translate or add words: "+text,
      response_format:{type:"audio"},
      generation_config:{speech_config:[{voice:VOICE}]}
    }),
    signal:AbortSignal.timeout(120000)
  });
  const data = await response.json().catch(()=>({}));
  if(!response.ok) throw new Error("Gemini TTS ("+response.status+"): "+(data.error?.message||"មិនអាចបង្កើតសំឡេងបានទេ។"));
  const encoded=data.output_audio?.data;
  if(!encoded) throw new Error("Gemini មិនបានផ្ញើសំឡេងត្រឡប់មកទេ។");
  const pcm=Buffer.from(encoded,"base64");
  if(pcm.length<100) throw new Error("ទិន្នន័យសំឡេងពី Gemini មិនគ្រប់គ្រាន់ទេ។");
  await fs.writeFile(outputPath,makeWav(pcm));
}
function update(job,values){Object.assign(job,values,{updatedAt:Date.now()});}

async function runJob(job,videoBuffer,segments,apiKey){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"translat-khmer-dub-"));
  try{
    const input=path.join(dir,"input-video"),output=path.join(dir,"TRANSLAT-KHMER-DUBBED.mp4");
    await fs.writeFile(input,videoBuffer);
    const probeText=await run(ffprobe.path,["-v","error","-show_entries","format=duration:stream=codec_type","-of","json",input]);
    const probe=JSON.parse(probeText),duration=Number(probe.format?.duration);
    if(!Number.isFinite(duration)||duration<=0||!probe.streams?.some(s=>s.codec_type==="video")) throw new Error("មិនអាចអានរយៈពេល ឬ Video Stream របស់វីដេអូនេះបានទេ។");
    const hasOriginalAudio=probe.streams.some(s=>s.codec_type==="audio");
    const clean=segments.map(s=>({start:Math.max(0,Math.min(duration,Number(s.start)||0)),text:String(s.translation||s.khmer||"").trim()})).filter(s=>s.text&&s.start<duration);
    if(!clean.length) throw new Error("មិនមានឃ្លាខ្មែរដែលអាចបង្កើតសំឡេងបានទេ។");
    const audioFiles=[];
    for(let i=0;i<clean.length;i++){
      const audioFile=path.join(dir,"voice-"+i+".wav");
      await makeSpeech(clean[i].text,apiKey,audioFile); audioFiles.push(audioFile);
      update(job,{progress:5+Math.round(((i+1)/clean.length)*75),stage:"កំពុងបង្កើតសំឡេងខ្មែរ "+(i+1)+"/"+clean.length});
    }
    update(job,{progress:84,stage:"កំពុងបញ្ចូលសំឡេងខ្មែរទៅក្នុង MP4"});
    const args=["-y","-i",input]; for(const file of audioFiles) args.push("-i",file);
    const filters=[],labels=[];
    audioFiles.forEach((_,i)=>{const label="v"+i;filters.push("["+(i+1)+":a]adelay="+Math.round(clean[i].start*1000)+":all=1,aresample=48000["+label+"]");labels.push("["+label+"]");});
    if(hasOriginalAudio){
      filters.push("[0:a]volume=0.18,aresample=48000[bg]");
      filters.push(labels.join("")+"[bg]amix=inputs="+(labels.length+1)+":duration=longest:dropout_transition=0:normalize=0,apad,atrim=duration="+duration.toFixed(3)+"[aout]");
    }else filters.push(labels.join("")+"amix=inputs="+labels.length+":duration=longest:dropout_transition=0:normalize=0,apad,atrim=duration="+duration.toFixed(3)+"[aout]");
    args.push("-filter_complex",filters.join(";"),"-map","0:v:0","-map","[aout]","-c:v","copy","-c:a","aac","-b:a","192k","-t",duration.toFixed(3),"-movflags","+faststart","-f","mp4",output);
    await run(ffmpegPath,args);
    const stat=await fs.stat(output); if(stat.size<1024) throw new Error("ឯកសារ MP4 ដែលបានបង្កើតមិនត្រឹមត្រូវទេ។");
    update(job,{status:"completed",progress:100,stage:"រួចរាល់",outputPath:output,outputSize:stat.size});
    job.cleanupTimer=setTimeout(async()=>{await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});jobs.delete(job.id);},JOB_TTL_MS);
  }catch(error){
    update(job,{status:"failed",progress:100,stage:"បរាជ័យ",error:error.message||"បង្កើតវីដេអូមិនបានទេ។"});
    await fs.rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}
export function createDubbingRouter(upload){
  const router=express.Router();
  router.post("/api/dub",(req,res,next)=>{
    if(!process.env.GEMINI_API_KEY) return res.status(503).json({ok:false,error:"Backend មិនទាន់កំណត់ GEMINI_API_KEY នៅ Render Environment ទេ។"});
    next();
  },upload.single("video"),(req,res)=>{
    if(!req.file) return res.status(400).json({ok:false,error:"សូមជ្រើសរើសវីដេអូ។"});
    let segments; try{segments=JSON.parse(req.body.segments||"[]");}catch{return res.status(400).json({ok:false,error:"ទិន្នន័យ Subtitle មិនត្រឹមត្រូវទេ។"});}
    if(!Array.isArray(segments)||!segments.length||segments.length>MAX_SEGMENTS) return res.status(400).json({ok:false,error:"ចំនួនឃ្លាត្រូវមានពី 1 ដល់ "+MAX_SEGMENTS+"។"});
    const id=crypto.randomUUID(),job={id,status:"processing",progress:2,stage:"បានទទួលវីដេអូ",createdAt:Date.now(),updatedAt:Date.now()};
    jobs.set(id,job);
    runJob(job,req.file.buffer,segments,process.env.GEMINI_API_KEY).catch(error=>update(job,{status:"failed",progress:100,stage:"បរាជ័យ",error:error.message}));
    res.status(202).json({ok:true,jobId:id});
  });
  router.get("/api/dub/:jobId",(req,res)=>{
    const job=jobs.get(req.params.jobId);
    if(!job) return res.status(404).json({ok:false,error:"រកមិនឃើញការងារនេះ ឬវាបានផុតកំណត់។"});
    res.json({ok:true,jobId:job.id,status:job.status,progress:job.progress,stage:job.stage,error:job.error||undefined,downloadUrl:job.status==="completed"?"/api/dub/"+job.id+"/download":undefined});
  });
  router.get("/api/dub/:jobId/download",(req,res)=>{
    const job=jobs.get(req.params.jobId);
    if(!job||job.status!=="completed"||!job.outputPath) return res.status(404).json({ok:false,error:"វីដេអូមិនទាន់រួចរាល់ ឬការងារបានផុតកំណត់។"});
    res.download(job.outputPath,"TRANSLAT-KHMER-DUBBED.mp4");
  });
  return router;
}
