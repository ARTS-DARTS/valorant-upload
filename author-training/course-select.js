import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';
import { doc, getDoc, getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const cfg = { apiKey:'AIzaSyA1ya7fO5ZSeeokEfRHikWwpBXeXYhm9ww', authDomain:'valorant-linemaps.firebaseapp.com', projectId:'valorant-linemaps', storageBucket:'valorant-linemaps.firebasestorage.app', messagingSenderId:'288103111419', appId:'1:288103111419:web:daca10a760282d40996e5e' };
const params = new URLSearchParams(location.search);
const links = [...document.querySelectorAll('[data-course]')];
links.forEach(link => {
  const url = new URL(link.href);
  url.searchParams.set('category', link.dataset.course);
  for (const key of ['uid','return']) { const value=params.get(key); if(value) url.searchParams.set(key,value); }
  link.href=url;
  const status=document.createElement('span'); status.className='course-status pending'; link.appendChild(status);
});
const progressPanel=document.createElement('section');
progressPanel.className='task-progress';
progressPanel.hidden=true;
progressPanel.innerHTML='<div><p>ЗАДАНИЯ И ПОЛУЧЕНИЕ ОЧКОВ</p><b data-task-count>0 из 4 заданий</b></div><strong data-task-points>0 / 20 ОЧКОВ</strong><div class="task-progress-track"><i data-task-progress style="width:0%"></i></div>';
document.querySelector('.select-copy')?.after(progressPanel);
let renderedCategories={};
let renderedLocalUid='';
function renderProgress(categories=renderedCategories, localUid=renderedLocalUid) {
  renderedCategories=categories;
  renderedLocalUid=localUid;
  let completed=0;
  const visibleLinks=links.filter(link=>!link.hidden);
  visibleLinks.forEach(link => {
    const category=link.dataset.course;
    const done=Boolean(categories[category]);
    completed+=done?1:0;
    const status=link.querySelector('.course-status');
    status.className=`course-status ${done?'complete':'pending'}`;
    status.textContent=done?'✓ ПРОЙДЕН · +5':'○ НЕ ПРОЙДЕН · +5';
  });
  const total=visibleLinks.length;
  progressPanel.hidden=total===0;
  progressPanel.querySelector('[data-task-count]').textContent=`${completed} из ${total} заданий`;
  progressPanel.querySelector('[data-task-points]').textContent=`${completed*5} / ${total*5} ОЧКОВ`;
  progressPanel.querySelector('[data-task-progress]').style.width=`${total?completed/total*100:0}%`;
}
const returnPath=params.get('return');
const siteLink=document.createElement('a');
siteLink.className='site-return';
siteLink.href=returnPath?.startsWith('/')&&!returnPath.startsWith('//')?returnPath:'/';
siteLink.textContent='← ВЕРНУТЬСЯ НА САЙТ';
document.querySelector('.select-brand')?.appendChild(siteLink);
const app=initializeApp(cfg);
const db=getFirestore(app);
const functions=getFunctions(app,'us-central1');
const getProgress=httpsCallable(functions,'getAuthorTrainingProgress');
let siteVisibilitySettings={};
async function applySiteVisibility(user=null){
  try{
    const [settingsSnapshot,userSnapshot]=await Promise.all([
      getDoc(doc(db,'settings','category_access_site')),
      user?getDoc(doc(db,'users',user.uid)):Promise.resolve(null),
    ]);
    siteVisibilitySettings=settingsSnapshot.exists()?settingsSnapshot.data():{};
    const role=userSnapshot?.exists()?String(userSnapshot.data()?.role||'').toLowerCase():'';
    const isStaff=role==='admin'||role==='moderator';
    links.forEach(link=>{
      const category=link.dataset.course;
      const publicVisible=siteVisibilitySettings[`${category}_visible`]!==false;
      const staffVisible=isStaff&&siteVisibilitySettings[`${category}_staff_enabled`]===true;
      link.hidden=!publicVisible&&!staffVisible;
    });
    renderProgress();
  }catch(error){
    console.error('training category visibility failed',{
      code:error?.code,
      message:error?.message||String(error),
    });
  }finally{ renderProgress(); }
}
onAuthStateChanged(getAuth(app),async user=>{
  try{
    await applySiteVisibility(user);
    if(!user)return;
    links.forEach(link=>{
      const url=new URL(link.href);
      url.searchParams.set('uid',user.uid);
      link.href=url;
    });
    const result=await getProgress();
    renderProgress(result.data?.categories||{},user.uid);
  }catch(error){
    console.error('training task progress failed',{
      uid:user.uid,
      code:error?.code,
      message:error?.message||String(error),
    });
  }finally{
    document.querySelector('.course-grid')?.removeAttribute('hidden');
    renderProgress();
    window.VLineupsLoader?.hide();
  }
});
