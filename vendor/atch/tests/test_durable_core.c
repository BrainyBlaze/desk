#define _POSIX_C_SOURCE 200809L
#include "atch_generation.h"
#include "atch_journal.h"
#include "atch_checkpoint.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void generation(void) { atch_generation_registry r; uint32_t g1,g2; atch_generation_init(&r,7); assert(!atch_generation_begin(&r,&g1)&&g1==8); assert(!atch_generation_rollback(&r,g1)); assert(!atch_generation_begin(&r,&g2)&&g2==9); assert(!atch_generation_commit(&r,g2)); assert(atch_generation_accepts(&r,9)); assert(!atch_generation_begin(&r,&g1)&&g1==10); }
static void journal(void) { char p[]="/tmp/atch-journal-XXXXXX"; int t=mkstemp(p); atch_journal j; unsigned char out[128], body[]="abc"; size_t n; atch_journal_cursor c,next; atch_journal_record r={1,2,3,0,body,3}; close(t); assert(!atch_journal_open(&j,p,64)); assert(!atch_journal_append(&j,&r)); c=(atch_journal_cursor){0,0,0}; assert(!atch_journal_read(&j,c,out,sizeof out,&n,&next)&&n==32&&next.generation==2&&next.output_offset==0); r.record_seq=4; assert(!atch_journal_append(&j,&r)); r.record_seq=5; assert(!atch_journal_append(&j,&r)); assert(atch_journal_was_truncated(&j)); atch_journal_close(&j); unlink(p); }
static void checkpoint(void) { char p[]="/tmp/atch-checkpoint-XXXXXX"; int fd=mkstemp(p); unsigned char in[]="snapshot", meta[]="meta", out[32]; atch_checkpoint_set s={3,2,44,1,in,8,meta,4}, got; close(fd); assert(!atch_checkpoint_write(p,&s)); assert(!atch_checkpoint_read(p,&got,out,sizeof out)); assert(got.format_version==3&&got.patch_version==2&&got.set_id==44&&got.snapshot_length==8&&!memcmp(out,in,8)&&got.metadata_length==4); unlink(p); }
static void recovery(void) { char p[]="/tmp/atch-recovery-XXXXXX"; int fd=mkstemp(p); atch_journal j; atch_journal_record r={1,1,1,17,"x",1}; unsigned char b[64]; size_t n; atch_journal_cursor next; close(fd); assert(!atch_journal_open(&j,p,128)); assert(!atch_journal_append(&j,&r)); atch_journal_close(&j); fd=open(p,O_WRONLY|O_APPEND); assert(fd>=0&&write(fd,"torn",4)==4); close(fd); assert(!atch_journal_open(&j,p,128)); assert(atch_journal_was_truncated(&j)); assert(!atch_journal_read(&j,(atch_journal_cursor){0,0,0},b,sizeof b,&n,&next)); atch_journal_close(&j); unlink(p); }
static void strict_checkpoint(void) { char p[]="/tmp/atch-strict-XXXXXX"; int fd=mkstemp(p); unsigned char in[]="x", out[8]; atch_checkpoint_set s={3,2,1,0,in,1,NULL,0}, got; close(fd); assert(!atch_checkpoint_write(p,&s)); fd=open(p,O_WRONLY|O_APPEND); assert(fd>=0&&write(fd,"x",1)==1); close(fd); assert(atch_checkpoint_read(p,&got,out,sizeof out)==EBADMSG); unlink(p); }
static void bounds(void) { atch_generation_registry r; uint32_t g; atch_generation_init(&r,UINT32_MAX-1); assert(atch_generation_begin(&r,&g)==ERANGE); atch_generation_init(&r,UINT32_MAX); assert(atch_generation_begin(&r,&g)==ERANGE); }
int main(void) { generation(); journal(); checkpoint(); recovery(); strict_checkpoint(); bounds(); puts("durable core: ok"); return 0; }
