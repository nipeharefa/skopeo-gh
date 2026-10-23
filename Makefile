.PHONY: test test-verbose

BATS ?= bats
TESTS ?= test

test:
	$(BATS) --print-output-on-failure $(TESTS)

test-verbose:
	$(BATS) --show-output-of-passing-tests $(TESTS)
