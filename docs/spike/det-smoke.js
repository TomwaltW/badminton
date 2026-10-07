// Cross-engine determinism smoke test: RK4 shuttle flights with quadratic drag, xorshift RNG, FNV-1a over Float64 bits.
function dsqrt(x){ if(!(x>0)) return 0; let s=1; while(x>=4){x*=0.25;s*=2;} while(x<1){x*=4;s*=0.5;} let y=(x+1)*0.5; for(let i=0;i<5;i++) y=0.5*(y+x/y); return y*s; }
let rs=0x2545f491; function rnd(){ let x=rs; x^=x<<13; x^=x>>>17; x^=x<<5; rs=x; return (x>>>0)/4294967296; }
const G=9.81, VT=6.5, K=G/(VT*VT);
function acc(v,g,sq){ const s=sq(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]); return [-K*s*v[0], -g-K*s*v[1], -K*s*v[2]]; }
function add(a,b,h){ return [a[0]+b[0]*h,a[1]+b[1]*h,a[2]+b[2]*h]; }
function rk4(p,v,dt,g,sq){ const a1=acc(v,g,sq), v2=add(v,a1,dt/2), a2=acc(v2,g,sq), v3=add(v,a2,dt/2), a3=acc(v3,g,sq), v4=add(v,a3,dt), a4=acc(v4,g,sq);
  const np=[0,0,0], nv=[0,0,0]; for(let i=0;i<3;i++){ np[i]=p[i]+dt/6*(v[i]+2*v2[i]+2*v3[i]+v4[i]); nv[i]=v[i]+dt/6*(a1[i]+2*a2[i]+2*a3[i]+a4[i]); } return [np,nv]; }
const f64=new Float64Array(1), u32=new Uint32Array(f64.buffer);
let h=0x811c9dc5; function mix(x){ f64[0]=x; h^=u32[0]; h=Math.imul(h,0x01000193); h^=u32[1]; h=Math.imul(h,0x01000193); }
function run(sq){ rs=0x2545f491; h=0x811c9dc5; let steps=0;
  for(let n=0;n<2000;n++){ const sp=20+rnd()*60, el=-0.4+rnd()*1.2, az=-0.3+rnd()*0.6, alpha=0.4+rnd()*1.1;
    // direction via unit vector built without trig: normalise (1, el, az)
    const L=sq(1+el*el+az*az); let p=[1,2.8,0], v=[sp*alpha/L, sp*alpha*el/L, sp*alpha*az/L];
    while(p[1]>0 && steps<5e6){ [p,v]=rk4(p,v,1/60,G*alpha*alpha,sq); steps++; if((steps%30)===0){ mix(p[0]);mix(p[1]);mix(p[2]);mix(v[0]);mix(v[1]);mix(v[2]); } }
    mix(p[0]); mix(p[2]); }
  return [(h>>>0).toString(16), steps]; }
const out=[];
out.push('dsqrt '+run(dsqrt).join(' '));
out.push('Math.sqrt '+run(Math.sqrt).join(' '));
// transcendental sample hash (expected to be the risky part)
h=0x811c9dc5; for(let i=1;i<200000;i++){ const x=i*0.0137; mix(Math.sin(x)); mix(Math.exp(-x*0.01)); mix(Math.pow(x,0.37)); mix(Math.atan2(x,1.3)); }
out.push('trig '+(h>>>0).toString(16));
// sqrt exactness: compare Math.sqrt vs dsqrt bitwise
let diff=0; rs=12345; for(let i=0;i<200000;i++){ const x=rnd()*1e4; if(Math.sqrt(x)!==dsqrt(x)) diff++; } out.push('sqrt-vs-dsqrt mismatches '+diff+'/200000');
(typeof print==='function' && typeof console==='undefined' ? print : console.log)(out.join('\n'));
