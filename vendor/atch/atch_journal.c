#define _POSIX_C_SOURCE 200809L
#include "atch_journal.h"
#include "atch_wire_v3.h"
#include "atch_storage.h"
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static uint32_t g32(const unsigned char *p){return p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24;}
static uint64_t g64(const unsigned char *p){uint64_t v=0;int i;for(i=7;i>=0;i--)v=(v<<8)|p[i];return v;}
static void p32(unsigned char *p,uint32_t v){p[0]=v;p[1]=v>>8;p[2]=v>>16;p[3]=v>>24;}
static void p64(unsigned char *p,uint64_t v){int i;for(i=0;i<8;i++)p[i]=(unsigned char)(v>>(8*i));}
static size_t record_size(const unsigned char *h){return 29u+(size_t)g32(h+21);}
static int cursor_before(atch_journal_cursor a,atch_journal_cursor b){return a.generation<b.generation||(a.generation==b.generation&&(a.record_seq<b.record_seq||(a.record_seq==b.record_seq&&a.output_offset<b.output_offset)));}
static int scan(atch_journal *j){struct stat st;unsigned char h[25],*record;uint64_t off=0;ssize_t n;size_t size;atch_v3_record decoded;
	if(fstat(j->fd,&st)<0)return errno;
	j->end_offset=0;j->first_offset=0;j->truncated=0;j->gap=0;
	while(off<(uint64_t)st.st_size){n=pread(j->fd,h,sizeof h,off);if(n!=25)break;size=record_size(h);if(size>j->limit||size<29||off+size>(uint64_t)st.st_size){break;}
		record=malloc(size);if(!record)return ENOMEM;if(pread(j->fd,record,size,off)!=(ssize_t)size||atch_v3_decode_record(record,size,&decoded)){free(record);break;}
		if(!off)j->first_cursor=(atch_journal_cursor){decoded.generation,decoded.record_seq,decoded.output_offset};
		j->end_offset=off+size;off+=size;free(record);
	}
	if(off!=(uint64_t)st.st_size){if(ftruncate(j->fd,(off_t)off)<0)return errno;j->truncated=1;}
	while(j->end_offset-j->first_offset>j->limit){n=pread(j->fd,h,sizeof h,j->first_offset);if(n!=25)return EIO;j->first_offset+=record_size(h);j->gap=1;j->truncated=1;}
	if(j->first_offset<j->end_offset){n=pread(j->fd,h,sizeof h,j->first_offset);if(n!=25)return EIO;j->first_cursor=(atch_journal_cursor){g32(h+9),g64(h+1),g64(h+13)};}
	return 0;
}
int atch_journal_open(atch_journal *j,const char *path,size_t limit){if(!j||!path||!limit||limit>ATCH_MAX_JOURNAL)return EINVAL;memset(j,0,sizeof *j);j->fd=open(path,O_RDWR|O_CREAT,0600);j->limit=limit;if(j->fd<0)return errno;{int rc=scan(j);if(rc){close(j->fd);j->fd=-1;return rc;}}return 0;}
void atch_journal_close(atch_journal *j){if(j&&j->fd>=0)close(j->fd);if(j)j->fd=-1;}
int atch_journal_append(atch_journal *j,const atch_journal_record *r){unsigned char *p;size_t n;uint32_t crc;ssize_t w;if(!j||!r||r->body_length>ATCH_MAX_PAYLOAD||(!r->body&&r->body_length))return EINVAL;n=29u+r->body_length;p=malloc(n);if(!p)return ENOMEM;p[0]=r->record_type;p64(p+1,r->record_seq);p32(p+9,r->generation);p64(p+13,r->output_offset);p32(p+21,r->body_length);memcpy(p+25,r->body,r->body_length);crc=atch_v3_crc32(p,25+r->body_length);p32(p+25+r->body_length,crc);if(n>j->limit){free(p);return EFBIG;}w=pwrite(j->fd,p,n,j->end_offset);if(w!=(ssize_t)n){free(p);return errno;}if(!j->end_offset)j->first_cursor=(atch_journal_cursor){r->generation,r->record_seq,r->output_offset};j->end_offset+=n;free(p);while(j->end_offset-j->first_offset>j->limit){unsigned char h[25];if(pread(j->fd,h,25,j->first_offset)!=25)return EIO;j->first_offset+=record_size(h);j->gap=1;j->truncated=1;}if(j->first_offset<j->end_offset){unsigned char h[25];if(pread(j->fd,h,25,j->first_offset)!=25)return EIO;j->first_cursor=(atch_journal_cursor){g32(h+9),g64(h+1),g64(h+13)};}return 0;}
int atch_journal_read(const atch_journal *j,atch_journal_cursor after,unsigned char *buf,size_t cap,size_t *used,atch_journal_cursor *next){uint64_t off=0;unsigned char h[25];size_t n;ssize_t q;atch_v3_record record;if(!j||!buf||!used||!next)return EINVAL;*used=0;if(atch_journal_has_gap(j,after))return ENODATA;while(off<j->end_offset-j->first_offset){q=pread(j->fd,h,25,j->first_offset+off);if(q!=25)return EIO;n=record_size(h);if(g32(h+9)>after.generation||(g32(h+9)==after.generation&&(g64(h+1)>after.record_seq||(g64(h+1)==after.record_seq&&g64(h+13)>after.output_offset)))){if(n>cap)return ENOSPC;if(pread(j->fd,buf,n,j->first_offset+off)!=(ssize_t)n)return EIO;if(atch_v3_decode_record(buf,n,&record))return EBADMSG;*used=n;*next=(atch_journal_cursor){record.generation,record.record_seq,record.output_offset};return 0;}off+=n;}return ENOENT;}
int atch_journal_has_gap(const atch_journal *j,atch_journal_cursor c){return j&&j->gap&&c.generation&&cursor_before(c,j->first_cursor);}
int atch_journal_was_truncated(const atch_journal *j){return j&&j->truncated;}
