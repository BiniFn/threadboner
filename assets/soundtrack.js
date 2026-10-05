(function(){
'use strict';
/* Shared playlist controls for the homepage and reader. Browser autoplay
   rules still apply; playback can begin after the visitor presses play. */
var SK='tb-sound',TRACK_KEY='tb-track-index';

/* The remaining tracks are external and start only after user interaction. */
var TRACKS=[
  {title:'Last Game By Zwei',yt:'FeG4JH9f180'},
  {title:'Hacking to the Gate',yt:'dy7gr0vaNho'},
  {title:'Fatima',yt:'1xJbdY9B3A8'}
];

var audio=document.getElementById('bgm'),
    btn=document.getElementById('soundBtn'),
    nextBtn=document.getElementById('nextBtn'),
    nameEl=document.getElementById('trackName'),
    ytHost=document.getElementById('yt-host');

var playing=false, blocked=false, idx=0, stopping=false;
var yt=null, ytLoading=false, ytReady=false, loadedId=null, volume=0.34;

function pref(){try{return localStorage.getItem(SK)}catch(e){return null}}
function setPref(v){try{localStorage.setItem(SK,v)}catch(e){}}
function savedTrack(){try{var n=Number(localStorage.getItem(TRACK_KEY));return Number.isInteger(n)&&n>=0&&n<TRACKS.length?n:0}catch(e){return 0}}

function track(){return TRACKS[idx]}
function isLocalTrack(){return !!track().local}
function ytUrl(t){return t.yt?'https://www.youtube.com/watch?v='+t.yt:''}

/* ---------- state ---------- */
function paint(){
  btn.classList.toggle('playing',playing);
  btn.classList.toggle('blocked',blocked);
  btn.setAttribute('aria-pressed',playing?'true':'false');
  btn.setAttribute('aria-label',playing?'Pause soundtrack':'Play soundtrack');
  btn.title=blocked?'Tap anywhere to start the score':'Soundtrack';
  nextBtn.title='Next track — '+(track().title);
}
function started(){playing=true;blocked=false;paint()}
function refused(){playing=false;blocked=true;paint()}

/* ---------- local track ---------- */
function playLocal(){
  audio.src=track().local;
  audio.loop=true;
  try{audio.volume=volume}catch(e){}
  var p;
  try{p=audio.play()}catch(e){refused();return}
  if(p&&p.then)p.then(started).catch(refused);
  else started();
}
function stopLocal(){try{audio.pause()}catch(e){}}

/* ---------- YouTube track, loaded on demand ---------- */
/* The embed decides its own policy: it can force itself muted, and it has
   ignored playerVars.mute before. So never mute preemptively — ask for the
   volume we want after playback starts, and check whether we actually got it.
   Returns true when the player is audible. */
function applyVolume(){
  if(!yt)return false;
  try{y.setVolume(volume*100)}catch(e){}
  try{if(y.isMuted())y.unMute()}catch(e){}
  try{return !y.isMuted()}catch(e){return false}
}

function loadYouTube(cb){
  if(ytReady){cb();return}
  if(ytLoading){return}          // a second press just reuses the pending load
  ytLoading=true;
  window.onYouTubeIframeAPIReady=function(){
    ytLoading=false;
    ytReady=true;
    /* The API replaces #yt-host with the iframe itself, so the element that
       ends up in the DOM is the iframe — not a container holding one. */
    yt=new YT.Player('yt-host',{
      playerVars:{
        autoplay:1,
        controls:0,
        disablekb:1,
        modestbranding:1,
        playsinline:1,
        rel:0,
        /* The embed ignores mute:1 often enough that it is not relied on here.
           Instead mute is applied through the API once the player reports
           ready, then volume is set directly. */
        origin:location.origin==='null'?'':location.origin
      },
      events:{
        onReady:function(e){
          /* volume only. Muting here is what made every external track play
             silently — it was never undone. */
          try{e.target.setVolume(volume*100)}catch(err){}
          cb();
        },
        onStateChange:function(e){
          var d=e.data;
          /* ENDED from stopVideo() looks identical to the track finishing.
             Without this guard, pressing pause would skip to the next song. */
          if(d===YT.PlayerState.ENDED){
            if(stopping){stopping=false;playing=false;paint();return}
            goTo(idx+1,true);
            return;
          }
          if(d===YT.PlayerState.PLAYING){applyVolume();started()}
          else if(d===YT.PlayerState.BUFFERING&&!yt.isMuted()){started()}
          else if(d===YT.PlayerState.BUFFERING){playing=true;blocked=false;paint()}
          else if(d===YT.PlayerState.PAUSED){playing=false;paint()}
          else if(d===YT.PlayerState.CUED){playing=false;paint()}
        },
        onError:function(){fellBack('this track will not load')}
      }
    });
  };
  var tag=document.createElement('script');
  tag.src='https://www.youtube.com/iframe_api';
  tag.async=true;
  tag.onerror=function(){ytLoading=false;fellBack('YouTube could not be reached')};
  document.head.appendChild(tag);
}
/* Watch an external track until it is genuinely audible, or admit it is not. */
function settle(){
  var tries=[350,900,1800,3200,5000,7500,11000];
  (function next(i){
    if(isLocalTrack()||!yt)return;
    var audible=applyVolume();
    var st=-1;
    try{st=yt.getPlayerState()}catch(e){}
    var playing=(st===YT.PlayerState.PLAYING);
    var busy=(playing||st===YT.PlayerState.BUFFERING||st===YT.PlayerState.CUED);
    if(audible&&playing){started();return}          /* clears blocked */
    if(i>=tries.length){
      /* Only call it blocked when the track is genuinely running and we cannot
         get sound out of it. A slow-loading track is still loading, not
         blocked, and saying otherwise was wrong. */
      if(playing&&!audible){blocked=true;playing=false;paint();armUnmute()}
      else{playing=false;paint()}
      return;
    }
    if(!busy&&i>=4){playing=false;paint();return}     /* stalled, not blocked */
    setTimeout(function(){next(i+1)},tries[i]);
  })(0);
}

function playYT(){
  loadYouTube(function(){
    if(!yt||isLocalTrack())return;
    try{
      /* If this exact video is already in the player, resume it. Reloading by
         id restarts from zero and does not always fire a PLAYING event, which
         left the button stuck showing "paused" after a resume. */
      var loaded=(loadedId===track().yt);
      if(loaded&&yt.getPlayerState&&yt.getPlayerState()===YT.PlayerState.PAUSED){
        yt.playVideo();
      }else{
        loadedId=track().yt;
        yt.loadVideoById(track().yt);
      }
      applyVolume();
      started();
      /* The embed settles asynchronously and misled a single sample. It
         auto-mutes a programmatic loadVideoById, then unmutes itself once it
         decides the gesture counts — so a one-shot check at 900ms caught it
         mid-clamp and latched "blocked" on permanently, leaving the button
         claiming silence while the track played audibly. Sample across a
         window instead, and only give up if it is STILL muted at the end. */
      settle();
    }catch(e){fellBack('this track will not load')}
  });
}
function stopYT(){
  if(!yt)return;
  stopping=true;
  try{yt.stopVideo()}catch(e){}
  /* if no state change ever arrives, do not leave the guard armed */
  setTimeout(function(){stopping=false},600);
}

/* If an external track cannot play, do not leave a dead button — say so and
   stay on the current track rather than silently doing nothing. */
function fellBack(msg){
  blocked=false;playing=false;paint();
  nameEl.title=msg;
}

/* ---------- transport ---------- */
function goTo(n,autoplay){
  n=((n%TRACKS.length)+TRACKS.length)%TRACKS.length;
  try{localStorage.setItem(TRACK_KEY,String(n))}catch(e){}
  var wasPlaying=playing||autoplay;
  if(isLocalTrack())stopLocal();else stopYT();
  if(n!==idx)loadedId=null;   /* switching tracks: the next play must load */
  idx=n;
  /* label first, so the UI is right even while the source spins up */
  nameEl.textContent=track().title;
  var u=ytUrl(track());
  if(u){nameEl.href=u}else{nameEl.removeAttribute('href')}
  nameEl.title='';
  paint();
  if(wasPlaying||autoplay){
    if(isLocalTrack())playLocal();else playYT();
  }
}
/* If the embed is holding itself muted, the only thing that releases it is a
   real user gesture. One shot, then it detaches itself. */
function armUnmute(){
  var done=false;
  function onIt(){
    if(done)return;
    done=true;
    ['pointerdown','keydown','touchstart'].forEach(function(e){
      document.removeEventListener(e,onIt,true);
    });
    if(applyVolume()){started()}
    else{fellBack('the embed will not release sound here — open the track instead')}
  }
  ['pointerdown','keydown','touchstart'].forEach(function(e){
    document.addEventListener(e,onIt,{capture:true,passive:true});
  });
}

function start(){
  if(pref()==='paused')setPref('on');
  if(isLocalTrack())playLocal();else playYT();
}
function stop(){
  if(isLocalTrack())stopLocal();else stopYT();
  playing=false;blocked=false;setPref('off');paint();
}
/* The play/pause button: pause on an external track rather than unloading it,
   so resuming does not pay for a fresh load.

   Records 'paused' rather than 'off'. A visitor who paused should not be
   ambushed by sound on their next visit, but "paused" must stay resumable —
   collapsing it into "off" was conflating two different intentions. */
function pause(){
  if(isLocalTrack()){stopLocal();playing=false;blocked=false;setPref('paused');paint();return}
  if(yt){try{yt.pauseVideo()}catch(e){}}
  playing=false;blocked=false;setPref('paused');paint();
}

audio.addEventListener('playing',started);
audio.addEventListener('pause',function(){playing=false;blocked=false;paint()});
audio.addEventListener('error',function(){
  if(isLocalTrack()){nameEl.textContent='score unavailable';blocked=false;playing=false;paint()}
});

/* quiet enough to sit under text without fighting it */
try{audio.volume=volume}catch(e){}

/* if the browser refused, the first interaction anywhere starts it */
function armFirstGesture(){
  var done=false;
  function onFirst(){
    if(done)return;
    done=true;
    ['pointerdown','keydown','touchstart','wheel','scroll'].forEach(function(e){
      document.removeEventListener(e,onFirst,true);
    });
    if(pref()==='off'||pref()==='paused')return;
    if(!playing)start();
  }
  ['pointerdown','keydown','touchstart','wheel','scroll'].forEach(function(e){
    document.addEventListener(e,onFirst,{capture:true,passive:true});
  });
}

goTo(savedTrack(),false);
/* 'off' = never. 'paused' = silent until they ask. Both stay quiet on load. */
if(pref()!=='off'&&pref()!=='paused'){start();armFirstGesture()}

btn.addEventListener('click',function(){
  if(playing)pause();
  else if(blocked)start();
  else start();
});
nextBtn.addEventListener('click',function(){
  if(pref()==='off')setPref('on');
  goTo(idx+1,true);
});

})();
