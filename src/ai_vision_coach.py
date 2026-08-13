import cv2
import numpy as np


class AIVisionCoach:
    """Simple AI Javier Coach starter class."""

    def intro(self):
        print("AI Javier Coach started.")
        print("This project is a scaffold for image analysis and coaching workflows.")

    def analyze_sample(self):
        print("Analyzing sample image...")
        image = np.zeros((200, 200, 3), dtype=np.uint8)
        cv2.putText(image, "VISION", (10, 100), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 50, 150)
        edge_count = int(np.sum(edges > 0))
        print(f"Detected {edge_count} edge pixels in sample image.")
        print("Sample analysis complete.")
