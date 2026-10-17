# Python Quest – Escape the Coding Lab

An interactive browser game that teaches Grade 7–8 ICT students the basics of Python before their exam:
`print()`, `input()`, variables, `if / else` and `if / elif / else`.

**To play:** open `index.html` in any modern browser. Everything is in that one file. You don't need Python, a server, an account or an internet connection (without internet the fonts fall back to system fonts).

## What's inside

- **Five missions**, one per topic: The Output Chamber, The Input Gate, The Variable Vault, The Decision Dungeon, and The Final Boss (fought against *The Glitch*).
- **Briefings before every mission:** short lessons with runnable examples, values you can change (try scores 95, 82, 60, 40 and 75), and "broken code" demos that show real Python error messages.
- **Eight challenges per mission**, getting harder as you go. Challenge types: Predict the Output, Complete the Code, Find the Bug, Choose the Correct Code, Arrange the Code, What Happens Next?, Real-Life Coding, Match It, Test the Program, Fix the Order, and Explain Your Choice follow-ups.
- **Learning feedback:** every wrong option explains why it is wrong. Wrong answers show a step-by-step trace of the program and are followed by a *similar* challenge, which wins back half the credit.
- **Clearing a mission needs 70%,** so clicking at random won't pass. Stars are awarded at 70%, 80% and 90%.
- **XP, streak bonuses, ranks and 10 badges** (Output Master, Input Expert, Variable Wizard, Decision Maker, Python Champion, and more). A hint costs half the XP for that question. Replays earn half XP, and the exam only awards XP for a new best score, so XP can't be farmed.
- **Final exam simulation:** 15 questions (3 per topic, easy → moderate), a 20-minute timer, no hints, flag-and-review, and automatic submission when time runs out. After submitting you get a score out of 100, the correct answers with explanations, and the topics to revise.
- **Performance report:** a final score out of 100 (half mission mastery, half best exam), strengths, topics that need more practice, and the slip-ups you make most often.
- **Code Lab:** write and run your own programs, answer `input()` prompts, and step through them line by line.
- **Progress is saved** in the browser's local storage. Settings include a teacher preview mode that unlocks everything for classroom demos, and a progress reset.

## How answers are checked

The game includes **PyLite**, a small Python interpreter written in JavaScript (no `eval`). It runs every example and question, so expected outputs, the line where each bug is reported, and the step-by-step explanations are all calculated rather than typed in by hand. It reports Python-style errors such as `SyntaxError: expected ':'`, `IndentationError`, `NameError` and `TypeError`.

## Tests

```bash
node tests/validate.mjs                              # question bank + differential test against real Python 3
NODE_PATH=$(npm root -g) node tests/ui.mjs           # full playthrough in Chromium (needs Playwright)
```

`validate.mjs` checks every question, follow-up, generator and lesson. It confirms that each one has exactly one correct answer, that every wrong option has an explanation, that bug lines match where Python reports the error, and that the suggested fixes run. It then runs about 2,500 programs through both PyLite and CPython and requires identical output, error type and error line.
