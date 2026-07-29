#define _GNU_SOURCE
#include "atch_spawn.h"

#include <errno.h>
#include <signal.h>
#include <stdint.h>
#include <string.h>
#include <sys/wait.h>
#include <time.h>

struct sha256 { uint32_t h[8]; uint64_t bits; unsigned char buf[64]; size_t n; };
static uint32_t rotr(uint32_t x, unsigned n) { return (x >> n) | (x << (32 - n)); }
static const uint32_t k[64] = {
	0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,
	0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
	0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,
	0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
	0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,
	0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,
	0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,
	0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
	0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,
	0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
	0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
};
static void sha_block(struct sha256 *s, const unsigned char *p) {
	uint32_t w[64],a,b,c,d,e,f,g,h,t1,t2; unsigned i;
	for (i=0;i<16;i++) w[i]=(uint32_t)p[i*4]<<24|(uint32_t)p[i*4+1]<<16|(uint32_t)p[i*4+2]<<8|p[i*4+3];
	for (;i<64;i++) { uint32_t x=w[i-15], y=w[i-2]; w[i]=w[i-16]+(rotr(x,7)^rotr(x,18)^(x>>3))+w[i-7]+(rotr(y,17)^rotr(y,19)^(y>>10)); }
	a=s->h[0];b=s->h[1];c=s->h[2];d=s->h[3];e=s->h[4];f=s->h[5];g=s->h[6];h=s->h[7];
	for(i=0;i<64;i++){t1=h+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^((~e)&g))+k[i]+w[i];t2=(rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c));h=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;}
	s->h[0]+=a;s->h[1]+=b;s->h[2]+=c;s->h[3]+=d;s->h[4]+=e;s->h[5]+=f;s->h[6]+=g;s->h[7]+=h;
}
static void sha_init(struct sha256 *s){static const uint32_t h[]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};memcpy(s->h,h,sizeof h);s->bits=0;s->n=0;}
static void sha_add(struct sha256 *s,const void *v,size_t n){const unsigned char*p=v;s->bits+=(uint64_t)n*8;while(n){size_t m=64-s->n;if(m>n)m=n;memcpy(s->buf+s->n,p,m);s->n+=m;p+=m;n-=m;if(s->n==64){sha_block(s,s->buf);s->n=0;}}}
static void sha_done(struct sha256*s,unsigned char out[32]){unsigned char pad[72]={0x80};uint64_t bits=s->bits;size_t n=s->n;unsigned i;sha_add(s,pad, n<56?56-n:120-n);for(i=0;i<8;i++)s->buf[56+i]=(unsigned char)(bits>>(56-i*8));sha_block(s,s->buf);for(i=0;i<8;i++){out[i*4]=s->h[i]>>24;out[i*4+1]=s->h[i]>>16;out[i*4+2]=s->h[i]>>8;out[i*4+3]=s->h[i];}}

int atch_launch_validate(const struct atch_launch *l){size_t i,j;if(!l||!l->argv||!l->argv[0]||!l->argv[0][0])return -1;for(i=0;l->envp&&l->envp[i];i++){const char *eq=strchr(l->envp[i],'=');if(!eq||eq==l->envp[i])return -1;for(j=0;j<i;j++)if(!strncmp(l->envp[i],l->envp[j],(size_t)(eq-l->envp[i]))&&l->envp[j][eq-l->envp[i]]=='=')return -1;}return 0;}
int atch_launch_digest(const struct atch_launch*l,char d[65]){struct sha256 s;unsigned char raw[32];size_t i,j;if(atch_launch_validate(l)<0||!d)return -1;sha_init(&s);for(i=0;l->argv[i];i++){sha_add(&s,"A",1);sha_add(&s,l->argv[i],strlen(l->argv[i])+1);}for(i=0;l->envp&&l->envp[i];i++){sha_add(&s,"E",1);sha_add(&s,l->envp[i],strlen(l->envp[i])+1);}sha_done(&s,raw);for(i=0;i<32;i++)for(j=0;j<2;j++)d[i*2+j]="0123456789abcdef"[(raw[i]>>(4*(1-j)))&15];d[64]=0;return 0;}
int atch_worker_reserve(struct atch_worker*w){if(!w||w->reserved){errno=EBUSY;return -1;}w->reserved=1;return 0;} void atch_worker_release(struct atch_worker*w){if(w)w->reserved=0;}
int atch_reap_child(pid_t p,atch_wait_fn f,int*st){int r;if(!f)f=(atch_wait_fn)waitpid;do r=f(p,st,0);while(r<0&&errno==EINTR);return r==p?0:-1;}
int atch_stop_child(pid_t p,unsigned grace,atch_signal_fn sf,atch_wait_fn wf){int st;struct timespec ts={0,10000000};unsigned n;if(!sf||!wf||sf(p,SIGTERM)<0)return -1;for(n=0;n<grace/10+1;n++){if(wf(p,&st,WNOHANG)==p)return 0;nanosleep(&ts,NULL);}if(sf(p,SIGKILL)<0)return -1;return atch_reap_child(p,wf,&st);}
int atch_restart(void*a,const struct atch_restart_ops*o){int r;if(!o||!o->reserve||!o->stop||!o->launch||!o->commit)return -1;r=o->reserve(a);if(r<0)return r;r=o->stop(a);if(r<0){if(o->release)o->release(a);return r;}r=o->launch(a);if(r<0){if(o->release)o->release(a);return r;}r=o->commit(a);if(r<0){if(o->release)o->release(a);return r;}return 0;}
