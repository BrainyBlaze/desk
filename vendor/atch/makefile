VERSION ?= 1.6-bb1
CC = gcc
CFLAGS = -g -O2 -W -Wall -I. -DPACKAGE_VERSION=\"$(VERSION)\"
LDFLAGS =
LIBS = -lutil

UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
  STATIC_FLAG =
else
  STATIC_FLAG = -static
endif

OBJ = attach.o master.o atch.o tstate.o atch_security.o atch_storage.o atch_wire_v3.o
SRC = attach.c master.c atch.c tstate.c

IMAGE = atch-builder
BUILDDIR ?= .

archs = amd64 arm64
arch ?= $(shell arch)

atch: $(OBJ)
	$(CC) -o $(BUILDDIR)/$@ $(STATIC_FLAG) $(LDFLAGS) $(OBJ) $(LIBS)

atch.1.md: README.md scripts/readme2man.sh
	bash scripts/readme2man.sh $< > $@

atch.1: atch.1.md
	pandoc --standalone -t man $< -o $@

man: atch.1

clean:
	rm -f atch $(OBJ) security-storage-test wire-v3-test durable-core-test spawn-test *.1.md *.c~

.PHONY: security-storage-test
security-storage-test: tests/test_security_storage.c atch_security.c atch_storage.c atch_security.h atch_storage.h
	$(CC) $(CFLAGS) -std=c11 -Werror -o $@ tests/test_security_storage.c atch_security.c atch_storage.c
	./$@

.PHONY: wire-v3-test
wire-v3-test: tests/test_wire_v3.c atch_wire_v3.c atch_wire_v3.h
	$(CC) $(CFLAGS) -std=c11 -Werror -o $@ tests/test_wire_v3.c atch_wire_v3.c
	./$@

.PHONY: durable-core-test
durable-core-test: tests/test_durable_core.c atch_generation.c atch_journal.c atch_checkpoint.c atch_generation.h atch_journal.h atch_checkpoint.h atch_wire_v3.c atch_wire_v3.h atch_storage.h
	$(CC) $(CFLAGS) -std=c11 -Werror -o $@ tests/test_durable_core.c atch_generation.c atch_journal.c atch_checkpoint.c atch_wire_v3.c
	./$@

.PHONY: spawn-test
spawn-test: tests/test_spawn.c atch_spawn.c atch_spawn.h
	$(CC) $(CFLAGS) -std=c11 -Werror -o $@ tests/test_spawn.c atch_spawn.c
	./$@

.PHONY: fmt
fmt:
	docker run --rm -v "$$PWD":/src -w /src alpine:latest sh -c "apk add --no-cache indent && indent -linux $(SRCS) && indent -linux $(SRCS)"

.PHONY: fmt-all
fmt-all:
	$(MAKE) fmt SRCS="*.c"


attach.o: ./attach.c ./atch.h config.h
master.o: ./master.c ./atch.h config.h

atch_wire_v3.o: ./atch_wire_v3.c ./atch_wire_v3.h
atch.o: ./atch.c ./atch.h ./atch_storage.h config.h
tstate.o: ./tstate.c ./atch.h config.h

.PHONY: build-image
build-image:
	docker build -t $(IMAGE):$(arch) --platform linux/$(arch) -f build.dockerfile .

build-docker: build-image
	$(MAKE) clean
	docker run --rm -v "$$PWD":/src -e VERSION=$(VERSION) -w /src \
		--platform linux/$(arch) $(IMAGE):$(arch) ./build.sh

.PHONY: test
test: build-docker
	docker run --rm -v "$$PWD":/src \
		--platform linux/$(arch) $(IMAGE):$(arch) \
		sh /src/tests/test.sh /src/build/atch

.PHONY: release release-bin
release: man $(archs)

# CI release — no man page (no pandoc dep).
release-bin: $(archs:%=release-%)

release-%:
	mkdir -p release
	$(MAKE) build-docker arch=$* VERSION=$(VERSION)
	export COPYFILE_DISABLE=true; \
	tar -czf ./release/atch-linux-$*.tgz README.md -C ./build atch

$(archs):
	mkdir -p release
	$(MAKE) build-docker arch=$@ VERSION=$(VERSION)
	export COPYFILE_DISABLE=true; \
	tar -czf ./release/atch-linux-$@.tgz README.md atch.1 -C ./build atch; \
