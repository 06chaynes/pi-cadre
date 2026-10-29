class Rotation2D:
    def __init__(self, angle):
        self.angle = angle
    def matrix(self):
        return [[1, 0], [0, 1]]
