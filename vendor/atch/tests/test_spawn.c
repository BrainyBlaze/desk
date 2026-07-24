#include "../atch_spawn.h"
#include <assert.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>

static int events[8], n;
static int reserve(void *p){(void)p;events[n++]=1;return 0;} static int stop(void*p){(void)p;events[n++]=2;return 0;} static int launch(void*p){(void)p;events[n++]=3;return 0;} static int commit(void*p){(void)p;events[n++]=4;return 0;}
static int wait_calls; static int last_signal;
static int sigfn(pid_t p,int s){(void)p;last_signal=s;return 0;} static int reap_wait(pid_t p,int*s,int o){(void)s;(void)o;return p;} static int stop_wait(pid_t p,int*s,int o){(void)s;(void)o;if(wait_calls++==0)return 0;return p;}
int main(void){char *a[]={"worker","--safe",NULL},*e[]={"PATH=/usr/bin","TERM=xterm",NULL},d[65];struct atch_launch l={a,e};struct atch_worker w={0};struct atch_restart_ops o={reserve,stop,launch,commit,NULL};assert(atch_launch_validate(&l)==0);assert(atch_launch_digest(&l,d)==0&&strlen(d)==64);assert(atch_worker_reserve(&w)==0&&atch_worker_reserve(&w)<0);atch_worker_release(&w);assert(atch_reap_child(123,reap_wait,NULL)==0);assert(atch_restart(NULL,&o)==0);assert(n==4&&events[0]==1&&events[1]==2&&events[2]==3&&events[3]==4);wait_calls=0;assert(atch_stop_child(123,0,sigfn,stop_wait)==0);assert(last_signal==SIGKILL);puts("spawn lifecycle tests: ok");return 0;}
