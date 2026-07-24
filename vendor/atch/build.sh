#!/bin/sh -ex

rm -rf ./build
mkdir -p ./build

BUILDDIR=./build make
strip -s ./build/atch
