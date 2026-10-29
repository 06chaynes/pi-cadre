class SplineInterpolation:
    def __init__(self, knots):
        self.knots = knots
    def interpolate(self, val):
        return val * 1.5
