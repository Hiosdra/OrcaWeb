# TODO: Utwórz tag v0.5.0

Po zmergowaniu PR #42 do mastera należy ręcznie utworzyć i spushować annotated tag:

```bash
git fetch origin master
git tag -a "v0.5.0" -m "Release v0.5.0" origin/master
git push origin "v0.5.0"
```

Po wykonaniu możesz zamknąć ten PR.
