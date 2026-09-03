import dotenv from "dotenv";
import app from "./app.mjs";

dotenv.config();
const PORT = Number(process.env.PORT || 8787);
app.listen(PORT, () => {
  console.log(`Companion API lista en http://localhost:${PORT}`);
});
