#define _POSIX_C_SOURCE 200809L
#include "atch_checkpoint.h"
#include "atch_wire_v3.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

static int full_write(int fd, const void *vp, size_t n) {
    const unsigned char *p = vp;
    while (n) { ssize_t w = write(fd, p, n); if (w < 0 && errno == EINTR) continue; if (w <= 0) return w ? errno : EIO; p += w; n -= (size_t)w; }
    return 0;
}
static int full_read(int fd, void *vp, size_t n) {
    unsigned char *p = vp;
    while (n) { ssize_t r = read(fd, p, n); if (r < 0 && errno == EINTR) continue; if (r <= 0) return r ? errno : EBADMSG; p += r; n -= (size_t)r; }
    return 0;
}
static void put32(unsigned char *p, uint32_t v) { p[0]=v; p[1]=v>>8; p[2]=v>>16; p[3]=v>>24; }
static uint32_t get32(const unsigned char *p) { return p[0]|(uint32_t)p[1]<<8|(uint32_t)p[2]<<16|(uint32_t)p[3]<<24; }
static void put64(unsigned char *p, uint64_t v) { int i; for (i=0;i<8;i++) p[i]=(unsigned char)(v>>(8*i)); }
static uint64_t get64(const unsigned char *p) { uint64_t v=0; int i; for (i=7;i>=0;i--) v=(v<<8)|p[i]; return v; }

int atch_checkpoint_write(const char *path, const atch_checkpoint_set *s) {
    char tmp[4096], *slash; unsigned char h[45]; int fd, rc; uint32_t crc;
    if (!path || !s || !s->format_version || !s->patch_version || s->snapshot_kind > 1 || s->snapshot_length > ATCH_V3_MAX_CHECKPOINT || s->metadata_length > ATCH_V3_MAX_CHECKPOINT || (!s->snapshot && s->snapshot_length) || (!s->metadata && s->metadata_length)) return EINVAL;
    if (snprintf(tmp, sizeof tmp, "%s.tmp", path) >= (int)sizeof tmp) return ENAMETOOLONG;
    fd=open(tmp,O_WRONLY|O_CREAT|O_TRUNC,0600); if(fd<0)return errno;
    memcpy(h,"ATC3",4); put32(h+4,s->format_version); put32(h+8,s->patch_version); put64(h+12,s->set_id); h[20]=s->snapshot_kind; put64(h+21,s->snapshot_length); put64(h+29,s->metadata_length); crc=atch_v3_crc32(s->snapshot,s->snapshot_length); put32(h+37,crc); put32(h+41,atch_v3_crc32(s->metadata,s->metadata_length));
    rc=full_write(fd,h,sizeof h); if(!rc)rc=full_write(fd,s->snapshot,s->snapshot_length); if(!rc)rc=full_write(fd,s->metadata,s->metadata_length); if(!rc&&fsync(fd)<0)rc=errno; if(close(fd)<0&&!rc)rc=errno; if(rc){unlink(tmp);return rc;}
    if(rename(tmp,path)<0){rc=errno;unlink(tmp);return rc;} slash=strrchr(path,'/'); {char dir[4096];size_t n=slash?(size_t)(slash-path):0;if(n>=sizeof dir)return ENAMETOOLONG;if(slash){memcpy(dir,path,n);dir[n]=0;}else strcpy(dir,".");fd=open(dir,O_RDONLY|O_DIRECTORY);if(fd<0)return errno;rc=fsync(fd);close(fd);if(rc<0)return errno;} return 0;
}
int atch_checkpoint_read(const char *path, atch_checkpoint_set *s, void *snapshot, size_t cap) {
    int fd,rc; unsigned char h[45]; uint64_t sl,ml; unsigned char *meta;
    if(!path||!s||(!snapshot&&cap))return EINVAL;
    fd=open(path,O_RDONLY);if(fd<0)return errno; rc=full_read(fd,h,sizeof h); if(rc||memcmp(h,"ATC3",4)||!get32(h+4)||!get32(h+8)||h[20]>1){close(fd);return EBADMSG;}
    sl=get64(h+21);ml=get64(h+29);if(sl>cap||sl>ATCH_V3_MAX_CHECKPOINT||ml>ATCH_V3_MAX_CHECKPOINT){close(fd);return EINVAL;}rc=full_read(fd,snapshot,(size_t)sl);if(!rc&&atch_v3_crc32(snapshot,(size_t)sl)!=get32(h+37))rc=EBADMSG;meta=ml?malloc((size_t)ml):NULL;if(ml&&!meta)rc=ENOMEM;if(!rc)rc=full_read(fd,meta,(size_t)ml);if(!rc&&atch_v3_crc32(meta,(size_t)ml)!=get32(h+41))rc=EBADMSG;{unsigned char extra;if(!rc&&read(fd,&extra,1)!=0)rc=EBADMSG;}free(meta);close(fd);if(rc)return rc;
    s->format_version=get32(h+4);s->patch_version=get32(h+8);s->set_id=get64(h+12);s->snapshot_kind=h[20];s->snapshot=snapshot;s->snapshot_length=(size_t)sl;s->metadata=NULL;s->metadata_length=(size_t)ml;return 0;
}
