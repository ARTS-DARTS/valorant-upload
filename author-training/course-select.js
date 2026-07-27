import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

const cfg = { apiKey:'AIzaSyA1ya7fO5ZSeeokEfRHikWwpBXeXYhm9ww', authDomain:'valorant-linemaps.firebaseapp.com', projectId:'valorant-linemaps', storageBucket:'valorant-linemaps.firebasestorage.app', messagingSenderId:'288103111419', appId:'1:288103111419:web:daca10a760282d40996e5e' };
const params = new URLSearchParams(location.search);
const links = [...document.querySelectorAll('[data-course]')];
const uid = params.get('uid') || 'guest';
links.forEach(link => {
  const url = new URL(link.href);
  url.searchParams.set('category', link.dataset.course);
  for (const key of ['uid','return']) { const value=params.get(key); if(value) url.searchParams.set(key,value); }
  link.href=url;
  const status=document.createElement('span'); status.className='course-status pending'; link.appendChild(status);
});
const progressPanel=document.createElement('section');
progressPanel.className='task-progress';
progressPanel.innerHTML='<div><p>ЗАДАНИЯ И ПОЛУЧЕНИЕ ОЧКОВ</p><b data-task-count>0 из 4 заданий</b></div><strong data-task-points>0 / 20 ОЧКОВ</strong><div class="task-progress-track"><i data-task-progress style="width:0%"></i></div>';
document.querySelector('.select-copy')?.after(progressPanel);
function renderProgress(categories={}) {
  let completed=0;
  links.forEach(link => {
    const category=link.dataset.course;
    const done=Boolean(categories[category])||Boolean(localStorage.getItem(`vl_category_training_${uid}_${category}`));
    completed+=done?1:0;
    const status=link.querySelector('.course-status');
    status.className=`course-status ${done?'complete':'pending'}`;
    status.textContent=done?'✓ ПРОЙДЕН · +5':'○ НЕ ПРОЙДЕН · +5';
  });
  progressPanel.querySelector('[data-task-count]').textContent=`${completed} из 4 заданий`;
  progressPanel.querySelector('[data-task-points]').textContent=`${completed*5} / 20 ОЧКОВ`;
  progressPanel.querySelector('[data-task-progress]').style.width=`${completed/4*100}%`;
}
renderProgress();
const returnPath=params.get('return');
const siteLink=document.createElement('a');
siteLink.className='site-return';
siteLink.href=returnPath?.startsWith('/')&&!returnPath.startsWith('//')?returnPath:'/';
siteLink.textContent='← ВЕРНУТЬСЯ НА САЙТ';
document.querySelector('.select-brand')?.appendChild(siteLink);
const app=initializeApp(cfg);
const functions=getFunctions(app,'us-central1');
const getProgress=httpsCallable(functions,'getAuthorTrainingProgress');
const completeTraining=httpsCallable(functions,'completeAuthorTraining');
onAuthStateChanged(getAuth(app),async user=>{
  if(!user)return;
  try{
    for(const link of links){
      const category=link.dataset.course;
      if(localStorage.getItem(`vl_category_training_${uid}_${category}`)){
        await completeTraining({category});
      }
    }
    const result=await getProgress();
    renderProgress(result.data?.categories||{});
  }catch(error){console.warn('training task progress',error?.message||error);}
});
