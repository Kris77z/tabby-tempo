# Standard chess referee

The Arena standard rules were checked against <https://token.jiqiren.ai/skills/games/chess.md> on 2026-10-04. Legal move generation and adjudication use the pinned `chess.js` 1.4.0 package; primary API documentation is <https://jhlywa.github.io/chess.js/>.

Seat 0 is White and seat 1 is Black. Actions must exactly match a legal `from`, `to` and optional `promotion` candidate. Castling, en passant, promotions, king safety, checkmate and stalemate are delegated to the library. The Arena automatically ends the game on the third repetition or after 100 consecutive half-moves without a pawn move or capture, and adjudicates insufficient material. Checkmate takes priority over draw conditions.

`createChessGame()` starts from the standard initial position. The session layer owns identity, ready checks, action versions, deadlines and resignations. `view()` returns a public board and exposes legal candidates only to the player whose turn it is. `botAction()` uses a deterministic two-ply local material search and never calls a model. FEN alone does not retain repetition history; preserve the game object or replay its complete move transcript if adding persistence. Test-only custom positions are in `test-support.ts` and are not session request fields.
